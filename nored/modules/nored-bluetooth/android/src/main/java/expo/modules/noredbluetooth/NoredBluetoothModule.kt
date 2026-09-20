package expo.modules.noredbluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

private const val TAG = "NoredBLE"
private const val PREFS = "nored_ble_identity"
private const val DEVICE_ID = "device_id"
private const val DISPLAY_NAME = "display_name"
private const val AVATAR_ICON = "avatar_icon"
private const val AVATAR_COLOR = "avatar_color"
private val AVATAR_ICONS = listOf("nearby", "chats", "alerts", "games", "gear", "mic", "image", "send")
private const val AVATAR_COLOR_COUNT = 9
private const val STALE_PEER_MS = 45_000L
private const val STALE_BLUETOOTH_PEER_MS = 90_000L
private const val PACKET_MAGIC: Byte = 0x4E
private const val PACKET_HEADER_BYTES = 3
private const val MAX_ATTRIBUTE_VALUE_BYTES = 512
private const val MAX_CONNECTIONS = 6

private val SERVICE_UUID: UUID = UUID.fromString("6e4f5245-442d-4d45-5348-000000000001")
private val IDENTITY_UUID: UUID = UUID.fromString("6e4f5245-442d-4d45-5348-000000000002")
private val RX_UUID: UUID = UUID.fromString("6e4f5245-442d-4d45-5348-000000000003")
private val TX_UUID: UUID = UUID.fromString("6e4f5245-442d-4d45-5348-000000000004")
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

private data class PeerRecord(
  val id: String,
  val name: String,
  val address: String,
  var rssi: Int?,
  var lastSeen: Long,
  var nored: Boolean = false,
  var confirmedIdentity: Boolean = false,
  var avatarIcon: String? = null,
  var avatarColor: Int? = null,
)

private class WriteJob(
  val data: ByteArray,
  val packet: Boolean,
  val token: Int = 0,
  val index: Int = 0,
) {
  var attempts = 0
}

// A packet can travel over either link we may hold with a peer: a write to the peer's RX
// characteristic over our client GATT, or an indication on our TX characteristic to the
// peer's central. The route is chosen when the job reaches the head of the queue (never
// captured at enqueue time), so a link that died while the job waited is skipped instead
// of costing a timeout, and frames are cut to the MTU of the route actually used.
private sealed class SendRoute {
  data class Write(val address: String) : SendRoute()
  data class Notify(val address: String) : SendRoute()
}

private class SendJob(
  val peerId: String,
  val payload: ByteArray,
  val promise: Promise,
  val token: Int,
) {
  var frames: List<ByteArray> = emptyList()
  var index = 0
  var route: SendRoute? = null
  var writeFailed = false
  var notifyFailed = false
}

private data class FrameAssembler(
  val total: Int,
  val parts: MutableMap<Int, ByteArray>,
  var startedAt: Long,
)

class NoredBluetoothModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val peers = ConcurrentHashMap<String, PeerRecord>()
  private val addressToPeerId = ConcurrentHashMap<String, String>()
  private val gatts = ConcurrentHashMap<String, BluetoothGatt>()
  private val connecting = ConcurrentHashMap.newKeySet<String>()
  private val connectionTimeouts = ConcurrentHashMap<String, Runnable>()
  private val writeQueues = ConcurrentHashMap<String, ArrayDeque<WriteJob>>()
  private val writeBusy = ConcurrentHashMap<String, Boolean>()
  private val sendQueue = ArrayDeque<SendJob>()
  private val assemblers = ConcurrentHashMap<String, FrameAssembler>()
  private val serverDevices = ConcurrentHashMap<String, BluetoothDevice>()
  private val subscribedAddresses = ConcurrentHashMap.newKeySet<String>()
  private val indicateAddresses = ConcurrentHashMap.newKeySet<String>()
  private val identitySubscribedAddresses = ConcurrentHashMap.newKeySet<String>()
  private val clientMtuByAddress = ConcurrentHashMap<String, Int>()
  private val serverMtuByAddress = ConcurrentHashMap<String, Int>()
  private val lastEmitAt = ConcurrentHashMap<String, Long>()
  private var gattServer: BluetoothGattServer? = null
  private var identityCharacteristic: BluetoothGattCharacteristic? = null
  private var txCharacteristic: BluetoothGattCharacteristic? = null
  private var sending = false
  private var sendTimeout: Runnable? = null
  private var sendToken = 0
  private val identityNotifyQueue = ArrayDeque<BluetoothDevice>()
  private var identityNotifyInFlight = false
  private var identityPushPending = false
  private var started = false
  private var scannerRunning = false
  private var advertiserRunning = false
  private var receiverRegistered = false
  private var keepAliveTicks = 0
  private val reconnectAttempts = ConcurrentHashMap<String, Int>()
  private val reconnectRunnables = ConcurrentHashMap<String, Runnable>()

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context is unavailable", null)

  private val bluetoothManager: BluetoothManager?
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private val adapter: BluetoothAdapter?
    get() = bluetoothManager?.adapter

  override fun definition() = ModuleDefinition {
    Name("NoredBluetooth")

    Events("onPeerDiscovered", "onPeerLost", "onStateChanged", "onLog", "onPacketReceived")

    Function("isSupported") {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && adapter != null
    }

    Function("requiredPermissions") { requiredPermissionNames() }
    Function("getIdentity") { identityMap() }
    Function("getPeers") { peers.values.sortedByDescending { it.lastSeen }.map { peerMap(it) } }

    // Every piece of connection and send state below is touched only on the main thread.
    // GATT callbacks arrive on binder threads and are re-posted there (see onMain), so
    // the module functions must run there too.
    AsyncFunction("setDisplayName") { rawName: String ->
      val name = normalizedDisplayName(rawName)
        ?: throw CodedException("ERR_INVALID_NAME", "Display name must be 1 to 40 UTF-8 bytes", null)
      preferences().edit().putString(DISPLAY_NAME, name).commit()
      if (started) {
        if (sending) identityPushPending = true else publishIdentityUpdate()
      }
      identityMap()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("start") { startScanning() }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { stopScanning() }.runOnQueue(Queues.MAIN)
    AsyncFunction("sendPacket") { peerId: String, packet: String, promise: Promise ->
      beginSend(peerId, packet, promise)
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      if (started) {
        startScannerOnly()
        advertiserRunning = false
        startAdvertiser()
        startGattServer()
      }
    }

    OnDestroy { stopScanning() }
  }

  private fun preferences() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** GATT callbacks arrive on binder threads; serialise all state changes on main. */
  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
  }

  /**
   * Slots consumed by live and pending client links. An address sits in both `gatts` and
   * `connecting` while its connect is pending; counting it twice made three simultaneous
   * connects look like a full budget of six.
   */
  private fun linkBudgetUsed(): Int = (gatts.keys + connecting).toSet().size

  private fun writeAddress(peerId: String): String? {
    val candidates = LinkedHashSet<String>()
    peers[peerId]?.address?.let(candidates::add)
    addressToPeerId.forEach { (address, id) -> if (id == peerId) candidates.add(address) }
    return candidates.firstOrNull { address ->
      gatts[address]?.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID) != null
    }
  }

  private fun notifyDevice(peerId: String): BluetoothDevice? {
    if (txCharacteristic == null || gattServer == null) return null
    return serverDevices.values.firstOrNull { device ->
      addressToPeerId[device.address] == peerId && subscribedAddresses.contains(device.address)
    }
  }

  private fun hasLiveLink(peerId: String): Boolean = writeAddress(peerId) != null || notifyDevice(peerId) != null

  /**
   * Tell JS a confirmed peer's link state changed, so the router can retry queued
   * traffic the moment a link comes back rather than waiting out its backoff.
   */
  private fun emitLinkStateIfKnown(address: String) {
    val peerId = addressToPeerId[address] ?: return
    val peer = peers[peerId] ?: return
    if (peer.confirmedIdentity) emitPeer(peer)
  }

  private fun stableHash(input: String): UInt {
    var hash = 0u
    input.forEach { character ->
      hash = (hash * 31u + character.code.toUInt()) and 0xFFFFFFFFu
    }
    return hash
  }

  private fun avatarProfile(id: String): Pair<String, Int> {
    val hash = stableHash(id)
    val icon = AVATAR_ICONS[(hash % AVATAR_ICONS.size.toUInt()).toInt()]
    val color = ((hash * 31u) % AVATAR_COLOR_COUNT.toUInt()).toInt()
    return icon to color
  }

  private fun ensureAvatarProfile(id: String): Pair<String, Int> {
    val prefs = preferences()
    val storedIcon = prefs.getString(AVATAR_ICON, null)
    if (storedIcon != null && prefs.contains(AVATAR_COLOR)) {
      return storedIcon to prefs.getInt(AVATAR_COLOR, 0)
    }
    val profile = avatarProfile(id)
    prefs.edit().putString(AVATAR_ICON, profile.first).putInt(AVATAR_COLOR, profile.second).apply()
    return profile
  }

  private fun identityMap(): Map<String, Any> {
    val prefs = preferences()
    var id = prefs.getString(DEVICE_ID, null)
    if (id == null) {
      id = UUID.randomUUID().toString()
      prefs.edit().putString(DEVICE_ID, id).apply()
    }
    val storedName = prefs.getString(DISPLAY_NAME, null)
    val name = normalizedDisplayName(storedName ?: Build.MODEL) ?: "Android"
    if (storedName != name) {
      prefs.edit().putString(DISPLAY_NAME, name).apply()
    }
    val avatar = ensureAvatarProfile(id)
    return mapOf(
      "id" to id,
      "name" to name,
      "avatarIcon" to avatar.first,
      "avatarColor" to avatar.second,
    )
  }

  private fun normalizedDisplayName(rawName: String): String? {
    val trimmed = rawName.trim()
    if (trimmed.isEmpty()) return null
    val result = StringBuilder()
    var byteCount = 0
    val codePoints = trimmed.codePoints().iterator()
    while (codePoints.hasNext()) {
      val codePoint = codePoints.nextInt()
      val text = String(Character.toChars(codePoint))
      val bytes = text.toByteArray(StandardCharsets.UTF_8).size
      if (byteCount + bytes > 40) break
      result.append(text)
      byteCount += bytes
    }
    return result.toString().ifEmpty { null }
  }

  private fun identityJson(): ByteArray {
    val identity = identityMap()
    return JSONObject()
      .put("v", 2)
      .put("id", identity.getValue("id"))
      .put("name", identity.getValue("name"))
      .put("avatarIcon", identity.getValue("avatarIcon"))
      .put("avatarColor", identity.getValue("avatarColor"))
      .toString()
      .toByteArray(StandardCharsets.UTF_8)
  }

  private fun hasPermissions(): Boolean = requiredPermissionNames().all {
    context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
  }

  private fun requiredPermissionNames(): List<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_ADVERTISE,
      )
    } else {
      listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  @SuppressLint("MissingPermission")
  private fun startScanning() {
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      emitState("unsupported")
      throw CodedException("ERR_UNSUPPORTED", "Bluetooth LE is not supported on this device", null)
    }
    if (!hasPermissions()) {
      emitState("unauthorized")
      throw CodedException("ERR_PERMISSION", "Nearby Bluetooth permission is required", null)
    }
    started = true
    registerBluetoothReceiver()
    if (adapter?.isEnabled != true) {
      emitState("poweredOff")
      return
    }
    emitState("starting")
    startGattServer()
    startScannerOnly()
    startAdvertiser()
    keepAliveTicks = 0
    reconnectAttempts.clear()
    reconnectRunnables.values.forEach(mainHandler::removeCallbacks)
    reconnectRunnables.clear()
    mainHandler.removeCallbacks(cleanupPeers)
    mainHandler.postDelayed(cleanupPeers, 5_000L)
  }

  @SuppressLint("MissingPermission")
  private fun startScannerOnly(restart: Boolean = false) {
    if (!started || !hasPermissions() || adapter?.isEnabled != true) return
    val scanner = adapter?.bluetoothLeScanner ?: run {
      emitState("unsupported")
      return
    }
    if (scannerRunning && !restart) {
      emitState("running")
      return
    }
    try {
      scanner.stopScan(scanCallback)
      scanner.stopScan(noredScanCallback)
      scannerRunning = false
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
        .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
        .build()
      scanner.startScan(null, settings, scanCallback)
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
      scanner.startScan(listOf(filter), settings, noredScanCallback)
      scannerRunning = true
      log("info", "[BLE] scanner started")
      emitState("running")
    } catch (error: SecurityException) {
      scannerRunning = false
      emitState("unauthorized")
      log("error", "[ERROR] scanner permission denied")
    } catch (error: Exception) {
      scannerRunning = false
      log("error", "[ERROR] scanner failed: ${error.javaClass.simpleName}")
    }
  }

  @SuppressLint("MissingPermission")
  private fun startGattServer() {
    if (!started || !hasPermissions() || adapter?.isEnabled != true) return
    if (gattServer != null && identityCharacteristic != null && txCharacteristic != null) return
    val manager = bluetoothManager ?: return
    if (gattServer == null) {
      gattServer = manager.openGattServer(context, serverCallback)
    }
    try {
      gattServer?.clearServices()
    } catch (_: Exception) {}
    val identity = BluetoothGattCharacteristic(
      IDENTITY_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    identity.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    val rx = BluetoothGattCharacteristic(
      RX_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    val tx = BluetoothGattCharacteristic(
      TX_UUID,
      BluetoothGattCharacteristic.PROPERTY_INDICATE,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    tx.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    identityCharacteristic = identity
    txCharacteristic = tx
    val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(identity)
    service.addCharacteristic(rx)
    service.addCharacteristic(tx)
    val added = gattServer?.addService(service) == true
    if (!added) log("error", "[ERROR] GATT server service was not added")
  }

  @SuppressLint("MissingPermission")
  private fun startAdvertiser() {
    if (!started || !hasPermissions() || adapter?.isEnabled != true) return
    if (advertiserRunning) return
    if (adapter?.isMultipleAdvertisementSupported != true) {
      log("warn", "[BLE] this phone cannot advertise to other devices")
      return
    }
    val advertiser = adapter?.bluetoothLeAdvertiser ?: run {
      log("warn", "[BLE] advertiser unavailable")
      return
    }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setConnectable(true)
      .setTimeout(0)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .build()
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()
    try {
      advertiser.startAdvertising(settings, data, null, advertiseCallback)
    } catch (error: SecurityException) {
      log("error", "[ERROR] advertiser permission denied")
    } catch (error: Exception) {
      log("error", "[ERROR] advertiser failed: ${error.javaClass.simpleName}")
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopAdvertiser() {
    advertiserRunning = false
    try {
      adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    } catch (_: Exception) {}
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      advertiserRunning = true
      log("info", "[BLE] advertiser started")
    }

    override fun onStartFailure(errorCode: Int) {
      advertiserRunning = false
      log("error", "[ERROR] advertiser failed code=$errorCode")
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopScanning() {
    started = false
    unregisterBluetoothReceiver()
    mainHandler.removeCallbacks(cleanupPeers)
    failQueuedSends("Bluetooth stopped")
    try {
      if (hasPermissions()) {
        adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        adapter?.bluetoothLeScanner?.stopScan(noredScanCallback)
        scannerRunning = false
      }
    } catch (_: Exception) {}
    stopAdvertiser()
    closeConnections()
    stopGattServer()
    lastEmitAt.clear()
    emitState("stopped")
  }

  private val bluetoothStateReceiver = object : BroadcastReceiver() {
    override fun onReceive(receiverContext: Context?, intent: Intent?) {
      if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
      when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
        BluetoothAdapter.STATE_ON -> {
          log("info", "[BLE] Bluetooth powered on")
          startGattServer()
          startScannerOnly()
          startAdvertiser()
        }
        BluetoothAdapter.STATE_OFF -> {
          log("warn", "[BLE] Bluetooth powered off")
          stopAdvertiser()
          closeConnections()
          stopGattServer()
          emitState("poweredOff")
        }
      }
    }
  }

  private fun registerBluetoothReceiver() {
    if (receiverRegistered) return
    ContextCompat.registerReceiver(
      context,
      bluetoothStateReceiver,
      IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    receiverRegistered = true
  }

  private fun unregisterBluetoothReceiver() {
    if (!receiverRegistered) return
    try { context.unregisterReceiver(bluetoothStateReceiver) } catch (_: Exception) {}
    receiverRegistered = false
  }

  @SuppressLint("MissingPermission")
  private fun stopGattServer() {
    try {
      gattServer?.clearServices()
      gattServer?.close()
    } catch (_: Exception) {}
    gattServer = null
    identityCharacteristic = null
    txCharacteristic = null
  }

  @SuppressLint("MissingPermission")
  private fun closeConnections() {
    gatts.values.forEach { gatt ->
      try {
        gatt.disconnect()
        gatt.close()
      } catch (_: Exception) {}
    }
    gatts.clear()
    connecting.clear()
    connectionTimeouts.values.forEach(mainHandler::removeCallbacks)
    connectionTimeouts.clear()
    reconnectAttempts.clear()
    reconnectRunnables.values.forEach(mainHandler::removeCallbacks)
    reconnectRunnables.clear()
    writeQueues.clear()
    writeBusy.clear()
    serverDevices.clear()
    subscribedAddresses.clear()
    indicateAddresses.clear()
    identitySubscribedAddresses.clear()
    clientMtuByAddress.clear()
    serverMtuByAddress.clear()
    identityNotifyQueue.clear()
    mainHandler.removeCallbacks(identityNotifyTimeout)
    identityNotifyInFlight = false
    assemblers.clear()
    peers.keys.toList().forEach(::emitPeerLost)
    peers.clear()
    addressToPeerId.clear()
  }

  private val cleanupPeers = object : Runnable {
    override fun run() {
      if (!started) return
      val now = System.currentTimeMillis()
      gatts.values.forEach { gatt ->
        val id = addressToPeerId[gatt.device.address] ?: gatt.device.address
        peers[id]?.let { it.lastSeen = now }
      }
      serverDevices.values.forEach { device ->
        val id = addressToPeerId[device.address] ?: device.address
        peers[id]?.let { it.lastSeen = now }
      }
      peers.values.filter {
        val ttl = if (it.nored) STALE_PEER_MS else STALE_BLUETOOTH_PEER_MS
        it.lastSeen < now - ttl &&
          !gatts.containsKey(it.address) &&
          !connecting.contains(it.address) &&
          serverDevices.values.none { device -> device.address == it.address }
      }.forEach {
        peers.remove(it.id)
        addressToPeerId.entries.removeAll { entry -> entry.value == it.id }
        lastEmitAt.remove(it.id)
        emitPeerLost(it.id)
      }
      val assemblerCutoff = System.currentTimeMillis() - 10_000L
      assemblers.entries.removeAll { it.value.startedAt < assemblerCutoff }
      keepAliveTicks += 1
      if (!advertiserRunning) startAdvertiser()
      val restartScanEvery = if (gatts.isEmpty() && serverDevices.isEmpty()) 12 else 24
      if (keepAliveTicks % restartScanEvery == 0) {
        startScannerOnly(restart = true)
      } else {
        startScannerOnly()
      }
      if (keepAliveTicks % 4 == 0) {
        pollRemoteRssi()
      }
      if ((keepAliveTicks + 2) % 4 == 0) {
        refreshUnconfirmedIdentities()
      }
      mainHandler.postDelayed(this, 5_000L)
    }
  }

  private fun connectDelayMs(): Long {
    val id = identityMap()["id"] as String
    val hex = id.takeLast(2).toIntOrNull(16) ?: 0
    return 200L + (hex % 10) * 120L
  }

  private fun isBadgeAdvertisedName(name: String?): Boolean {
    val normalized = name?.trim()?.lowercase() ?: return false
    return normalized.startsWith("nored badge") || normalized.startsWith("nored-badge")
  }

  private fun handleScanResult(result: ScanResult, forceNored: Boolean) {
    if (!started) return
    val address = result.device.address
    val advertisedName = result.scanRecord?.deviceName?.trim()?.takeIf { it.isNotEmpty() }
    val now = System.currentTimeMillis()
    val peerId = addressToPeerId[address] ?: address
    val existing = peers[peerId] ?: peers[address]
    val alreadyNored = existing?.nored == true
    val advertisedService = result.scanRecord?.serviceUuids?.any { it.uuid == SERVICE_UUID } == true
    val isNored = alreadyNored || forceNored || advertisedService || isBadgeAdvertisedName(advertisedName)
    val fallbackName = existing?.name
      ?: result.device.name?.trim()?.takeIf { it.isNotEmpty() }
      ?: if (isNored) "Nored user" else "Unknown device"
    val displayName = if (existing?.confirmedIdentity == true) {
      existing.name
    } else {
      (advertisedName ?: fallbackName).take(40).let {
        if (isNored && it.equals("Unknown device", ignoreCase = true)) "Nored user" else it
      }
    }
    val nameChanged = existing != null && displayName != existing.name
    val bucketChanged = signalBucket(sanitizeRssi(result.rssi) ?: existing?.rssi) != signalBucket(existing?.rssi)
    val noredChanged = existing?.nored != isNored
    val record = PeerRecord(
      id = peerId,
      name = displayName,
      address = address,
      rssi = sanitizeRssi(result.rssi) ?: existing?.rssi,
      lastSeen = now,
      nored = isNored,
      confirmedIdentity = existing?.confirmedIdentity == true,
      avatarIcon = existing?.avatarIcon,
      avatarColor = existing?.avatarColor,
    )
    if (peerId != address) {
      peers.remove(address)
    }
    peers[peerId] = record
    addressToPeerId[address] = peerId
    if (existing == null || noredChanged || nameChanged || bucketChanged) {
      lastEmitAt[peerId] = now
      emitPeer(record)
    }
    if (isNored && !gatts.containsKey(address) && !serverDevices.containsKey(address) && connecting.add(address)) {
      if (linkBudgetUsed() > MAX_CONNECTIONS) {
        connecting.remove(address)
        return
      }
      log("info", "[DISCOVERY] Nored advertisement RSSI ${result.rssi}")
      val device = result.device
      mainHandler.postDelayed({
        if (!started) {
          connecting.remove(address)
          return@postDelayed
        }
        if (gatts.containsKey(address) || serverDevices.containsKey(address)) {
          connecting.remove(address)
          return@postDelayed
        }
        connect(device)
      }, connectDelayMs())
    } else if (isNored && nameChanged && existing?.confirmedIdentity == true) {
      gatts[address]?.let { gatt ->
        gatt.getService(SERVICE_UUID)?.getCharacteristic(IDENTITY_UUID)?.let { identity ->
          readIdentity(gatt, identity)
        }
      }
    }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handleScanResult(result, forceNored = false)
    }

    override fun onScanFailed(errorCode: Int) {
      scannerRunning = false
      log("error", "[ERROR] scanner failed code=$errorCode")
      mainHandler.postDelayed({ if (started) startScannerOnly(restart = true) }, 2_000L)
    }
  }

  private val noredScanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handleScanResult(result, forceNored = true)
    }

    override fun onScanFailed(errorCode: Int) {
      scannerRunning = false
      log("error", "[ERROR] nored scanner failed code=$errorCode")
      mainHandler.postDelayed({ if (started) startScannerOnly(restart = true) }, 2_000L)
    }
  }

  // Always a direct connect with a timeout. autoConnect=true never times out, so it held a
  // `gatts` slot and the `connecting` flag forever; and iPhones rotate their random address,
  // so a background autoConnect to a stale address could never succeed. Scanning keeps
  // rediscovering the peer under its current address, which is what actually reconnects.
  @SuppressLint("MissingPermission")
  private fun connect(device: BluetoothDevice) {
    try {
      log("info", "[CONNECTION] connecting ${device.address}")
      val gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
      gatts[device.address] = gatt
      val timeout = Runnable {
        if (!connecting.remove(device.address)) return@Runnable
        connectionTimeouts.remove(device.address)
        if (gatts[device.address] === gatt) gatts.remove(device.address)
        try {
          gatt.disconnect()
          gatt.close()
        } catch (_: Exception) {}
        log("warn", "[CONNECTION] connect timed out ${device.address}")
        scheduleReconnect(device)
      }
      connectionTimeouts.put(device.address, timeout)?.let(mainHandler::removeCallbacks)
      mainHandler.postDelayed(timeout, 12_000L)
    } catch (error: Exception) {
      connecting.remove(device.address)
      log("error", "[ERROR] connect failed: ${error.javaClass.simpleName}")
      scheduleReconnect(device)
    }
  }

  private fun scheduleReconnect(device: BluetoothDevice) {
    val address = device.address
    reconnectRunnables.remove(address)?.let(mainHandler::removeCallbacks)
    // Never let reconnect attempts starve the connection budget: if every slot is spoken
    // for by live links or pending connects, a fresh nearby peer can't get in. Drop this
    // reconnect and let scanning rediscover the peer when a slot frees up.
    if (!gatts.containsKey(address) &&
      !connecting.contains(address) &&
      linkBudgetUsed() >= MAX_CONNECTIONS
    ) {
      reconnectAttempts.remove(address)
      return
    }
    val attempt = reconnectAttempts[address] ?: 0
    if (attempt >= 10) return
    reconnectAttempts[address] = attempt + 1
    val delay = min(8_000L, 800L * (1L shl min(attempt, 4)))
    val retry = Runnable {
      reconnectRunnables.remove(address)
      if (!started) return@Runnable
      if (gatts.containsKey(address) || connecting.contains(address)) return@Runnable
      if (serverDevices.containsKey(address)) return@Runnable
      if (linkBudgetUsed() >= MAX_CONNECTIONS) return@Runnable
      if (!connecting.add(address)) return@Runnable
      connect(device)
    }
    reconnectRunnables[address] = retry
    mainHandler.postDelayed(retry, delay)
  }

  // When a central connects to our GATT server we can't read its identity from the server
  // role, so connect back as a client to run the two-way identity exchange (and read RSSI).
  // Without this, peers that reach us server-side stay unconfirmed and hidden in the UI.
  @SuppressLint("MissingPermission")
  private fun connectBackIfNeeded(device: BluetoothDevice) {
    val address = device.address
    if (!started) return
    if (gatts.containsKey(address) || connecting.contains(address)) return
    if (linkBudgetUsed() >= MAX_CONNECTIONS) return
    if (!connecting.add(address)) return
    connect(device)
  }

  /**
   * A client link whose ATT transaction never completes is dead: Android will not start
   * the next write on it, so tear it down now and let the reconnect path replace it.
   */
  @SuppressLint("MissingPermission")
  private fun dropClientLink(address: String) {
    val gatt = gatts.remove(address) ?: return
    connecting.remove(address)
    connectionTimeouts.remove(address)?.let(mainHandler::removeCallbacks)
    clientMtuByAddress.remove(address)
    writeQueues.remove(address)
    writeBusy.remove(address)
    val device = gatt.device
    try {
      gatt.disconnect()
      gatt.close()
    } catch (_: Exception) {}
    log("warn", "[CONNECTION] dropped unresponsive link $address")
    emitLinkStateIfKnown(address)
    if (started) scheduleReconnect(device)
  }

  @SuppressLint("MissingPermission")
  private fun dropServerLink(address: String) {
    subscribedAddresses.remove(address)
    indicateAddresses.remove(address)
    val device = serverDevices[address] ?: return
    try { gattServer?.cancelConnection(device) } catch (_: Exception) {}
    log("warn", "[CONNECTION] dropped unresponsive central $address")
    emitLinkStateIfKnown(address)
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) = onMain {
      clientConnectionChanged(gatt, status, newState)
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) = onMain {
      clientMtuChanged(gatt, mtu, status)
    }

    override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) = onMain {
      if (status == BluetoothGatt.GATT_SUCCESS) applyRssi(gatt.device.address, rssi)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) = onMain {
      clientServicesDiscovered(gatt, status)
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = onMain {
      if (descriptor.uuid == CCCD_UUID && descriptor.characteristic.uuid == TX_UUID) {
        val identity = gatt.getService(SERVICE_UUID)?.getCharacteristic(IDENTITY_UUID)
        if (identity != null) readIdentity(gatt, identity)
      }
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int,
    ) = onMain {
      if (characteristic.uuid == IDENTITY_UUID && status == BluetoothGatt.GATT_SUCCESS) {
        receiveIdentity(gatt, value)
      }
    }

    @Deprecated("Deprecated in Android 13")
    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
      val value = characteristic.value ?: return
      onMain {
        if (characteristic.uuid == IDENTITY_UUID && status == BluetoothGatt.GATT_SUCCESS) {
          receiveIdentity(gatt, value)
        }
      }
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) = onMain {
      clientWriteCompleted(gatt, characteristic, status)
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) = onMain {
      clientValueChanged(gatt, characteristic, value)
    }

    @Deprecated("Deprecated in Android 13")
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
      val value = characteristic.value ?: return
      onMain { clientValueChanged(gatt, characteristic, value) }
    }
  }

  @SuppressLint("MissingPermission")
  private fun clientConnectionChanged(gatt: BluetoothGatt, status: Int, newState: Int) {
    val address = gatt.device.address
    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
      connectionTimeouts.remove(address)?.let(mainHandler::removeCallbacks)
      connecting.remove(address)
      gatts[address] = gatt
      reconnectAttempts.remove(address)
      reconnectRunnables.remove(address)?.let(mainHandler::removeCallbacks)
      log("info", "[CONNECTION] connected $address")
      startAdvertiser()
      if (!gatt.requestMtu(185)) gatt.discoverServices()
    } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
      try { gatt.close() } catch (_: Exception) {}
      // A late callback from a link we already replaced must not tear down its successor.
      if (gatts[address] !== gatt) return
      connectionTimeouts.remove(address)?.let(mainHandler::removeCallbacks)
      connecting.remove(address)
      gatts.remove(address)
      clientMtuByAddress.remove(address)
      writeQueues.remove(address)
      writeBusy.remove(address)
      log("info", "[CONNECTION] disconnected $address status=$status")
      writeLinkLost(address)
      emitLinkStateIfKnown(address)
      startAdvertiser()
      if (started) scheduleReconnect(gatt.device)
    }
  }

  @SuppressLint("MissingPermission")
  private fun clientMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
    log("info", "[CONNECTION] MTU $mtu status=$status")
    if (status == BluetoothGatt.GATT_SUCCESS) {
      clientMtuByAddress[gatt.device.address] = mtu
    }
    gatt.discoverServices()
  }

  @SuppressLint("MissingPermission")
  private fun clientServicesDiscovered(gatt: BluetoothGatt, status: Int) {
    if (status != BluetoothGatt.GATT_SUCCESS) {
      log("error", "[ERROR] service discovery failed status=$status")
      gatt.disconnect()
      return
    }
    val service = gatt.getService(SERVICE_UUID)
    val tx = service?.getCharacteristic(TX_UUID)
    val identity = service?.getCharacteristic(IDENTITY_UUID)
    if (service == null || tx == null || identity == null) {
      log("error", "[ERROR] Nored GATT service is incomplete")
      gatt.disconnect()
      return
    }
    gatt.setCharacteristicNotification(tx, true)
    val descriptor = tx.getDescriptor(CCCD_UUID)
    if (descriptor == null) {
      readIdentity(gatt, identity)
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(descriptor, cccdEnableValue(tx))
    } else {
      @Suppress("DEPRECATION")
      descriptor.value = cccdEnableValue(tx)
      @Suppress("DEPRECATION")
      gatt.writeDescriptor(descriptor)
    }
  }

  @SuppressLint("MissingPermission")
  private fun clientWriteCompleted(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
    if (characteristic.uuid != RX_UUID) return
    val address = gatt.device.address
    if (gatts[address] !== gatt) return
    val job = writeQueues[address]?.poll()
    writeBusy[address] = false
    if (job == null) {
      drainWrite(address)
      return
    }
    if (job.packet) {
      // Only the frame we are actually waiting on may advance the queue; a response for a
      // frame that already timed out (and whose job moved on) is ignored.
      val send = sendQueue.peek()
      val current = sending && send != null && send.route == SendRoute.Write(address) &&
        send.token == job.token && send.index == job.index
      if (current) {
        if (status == BluetoothGatt.GATT_SUCCESS) {
          advanceFrame()
        } else {
          log("warn", "[MSG] write failed status=$status")
          abandonRoute()
        }
      }
    } else if (status == BluetoothGatt.GATT_SUCCESS) {
      log("info", "[DISCOVERY] local identity exchanged")
      subscribeIdentityNotifications(gatt)
      requestRssi(gatt)
    } else {
      log("error", "[ERROR] identity write failed status=$status")
      mainHandler.postDelayed({
        if (gatts[address] === gatt) enqueueWrite(address, identityJson(), packet = false)
      }, 400L)
    }
    drainWrite(address)
  }

  private fun clientValueChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    if (characteristic.uuid == TX_UUID) {
      val peerId = addressToPeerId[gatt.device.address] ?: gatt.device.address
      ingestFrame(peerId, value)
    } else if (characteristic.uuid == IDENTITY_UUID) {
      receiveIdentity(gatt, value, exchangeIdentity = false)
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) = onMain {
      serverConnectionChanged(device, newState)
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) = onMain {
      serverMtuByAddress[device.address] = mtu
      log("info", "[CONNECTION] server MTU $mtu ${device.address}")
    }

    override fun onServiceAdded(status: Int, service: BluetoothGattService?) {
      if (status == BluetoothGatt.GATT_SUCCESS) {
        log("info", "[BLE] GATT server ready")
      } else {
        log("error", "[ERROR] GATT server add failed status=$status")
      }
    }

    @SuppressLint("MissingPermission")
    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid != IDENTITY_UUID) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        return
      }
      val data = identityJson()
      val slice = if (offset >= data.size) ByteArray(0) else data.copyOfRange(offset, data.size)
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
    }

    @SuppressLint("MissingPermission")
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (characteristic.uuid != RX_UUID || value == null) {
        if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        return
      }
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      // Peers frame to ATT_MTU-3 so a prepared (long) write never carries a Nored frame;
      // acknowledging it above keeps the link alive, but its parts are not reassembled.
      if (preparedWrite) return
      onMain { handleIncoming(device, value) }
    }

    // Without a response here a client that did send a long write waits out the 30s ATT
    // timeout and the whole link drops.
    @SuppressLint("MissingPermission")
    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      if (descriptor.uuid != CCCD_UUID) return
      onMain { serverSubscriptionChanged(device, descriptor.characteristic.uuid, value) }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) = onMain {
      serverNotificationSent(device, status)
    }
  }

  @SuppressLint("MissingPermission")
  private fun serverConnectionChanged(device: BluetoothDevice, newState: Int) {
    val address = device.address
    if (newState == BluetoothProfile.STATE_CONNECTED) {
      serverDevices[address] = device
      reconnectAttempts.remove(address)
      reconnectRunnables.remove(address)?.let(mainHandler::removeCallbacks)
      log("info", "[CONNECTION] central connected $address")
      startAdvertiser()
      connectBackIfNeeded(device)
    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
      serverDevices.remove(address)
      subscribedAddresses.remove(address)
      indicateAddresses.remove(address)
      identitySubscribedAddresses.remove(address)
      serverMtuByAddress.remove(address)
      identityNotifyQueue.removeAll { it.address == address }
      log("info", "[CONNECTION] central disconnected $address")
      notifyLinkLost(address)
      emitLinkStateIfKnown(address)
      startAdvertiser()
      if (started) scheduleReconnect(device)
    }
  }

  private fun serverSubscriptionChanged(device: BluetoothDevice, characteristic: UUID, value: ByteArray?) {
    val enabled = cccdEnabled(value)
    val address = device.address
    when (characteristic) {
      TX_UUID -> {
        if (enabled) {
          subscribedAddresses.add(address)
          if (value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)) {
            indicateAddresses.add(address)
          } else {
            indicateAddresses.remove(address)
          }
        } else {
          subscribedAddresses.remove(address)
          indicateAddresses.remove(address)
          notifyLinkLost(address)
        }
        emitLinkStateIfKnown(address)
      }
      IDENTITY_UUID -> if (enabled) {
        identitySubscribedAddresses.add(address)
        identityNotifyQueue.add(device)
        pumpIdentityUpdates()
      } else {
        identitySubscribedAddresses.remove(address)
      }
    }
    if (enabled) serverDevices[address] = device
  }

  private fun serverNotificationSent(device: BluetoothDevice, status: Int) {
    if (identityNotifyInFlight) {
      mainHandler.removeCallbacks(identityNotifyTimeout)
      identityNotifyInFlight = false
      identityNotifyQueue.poll()
      if (status != BluetoothGatt.GATT_SUCCESS) {
        log("warn", "[DISCOVERY] display name update notify failed status=$status")
      }
      pumpIdentityUpdates()
      pumpSend()
      if (identityPushPending && !sending && !identityNotifyInFlight) {
        identityPushPending = false
        publishIdentityUpdate()
      }
      return
    }
    val job = sendQueue.peek() ?: return
    val route = job.route
    if (!sending || route !is SendRoute.Notify || route.address != device.address) return
    if (status == BluetoothGatt.GATT_SUCCESS) {
      advanceFrame()
    } else {
      log("warn", "[MSG] notify failed status=$status")
      abandonRoute()
    }
  }

  @SuppressLint("MissingPermission")
  private fun readIdentity(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
    if (!gatt.readCharacteristic(characteristic)) {
      log("error", "[ERROR] identity read could not be queued")
    }
  }

  @SuppressLint("MissingPermission")
  private fun subscribeIdentityNotifications(gatt: BluetoothGatt) {
    val identity = gatt.getService(SERVICE_UUID)?.getCharacteristic(IDENTITY_UUID) ?: return
    val descriptor = identity.getDescriptor(CCCD_UUID) ?: return
    if (!gatt.setCharacteristicNotification(identity, true)) return
    val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ==
        BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION")
      descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      @Suppress("DEPRECATION")
      gatt.writeDescriptor(descriptor)
    }
    if (!queued) log("warn", "[DISCOVERY] identity notifications unavailable")
  }

  @SuppressLint("MissingPermission")
  private fun receiveIdentity(
    gatt: BluetoothGatt,
    bytes: ByteArray,
    exchangeIdentity: Boolean = true,
  ) {
    try {
      val json = JSONObject(String(bytes, StandardCharsets.UTF_8))
      val id = json.getString("id").lowercase()
      val name = json.optString("name", "Nored device").take(40)
      val avatarIcon = json.optString("avatarIcon", "").ifEmpty { null }
      val avatarColor = if (json.has("avatarColor")) json.optInt("avatarColor") else null
      UUID.fromString(id)
      val address = gatt.device.address
      val previousId = addressToPeerId[address] ?: address
      val existing = peers[id] ?: peers[previousId] ?: peers[address]
      val record = PeerRecord(
        id = id,
        name = name,
        address = address,
        rssi = firstRssi(existing, peers[previousId], peers[address]),
        lastSeen = System.currentTimeMillis(),
        nored = true,
        confirmedIdentity = true,
        avatarIcon = avatarIcon ?: existing?.avatarIcon,
        avatarColor = avatarColor ?: existing?.avatarColor,
      )
      val replacesId = if (previousId != id && peers.containsKey(previousId)) previousId else null
      if (replacesId != null) {
        peers.remove(replacesId)
        lastEmitAt.remove(replacesId)
      }
      if (address != id) {
        peers.remove(address)
        lastEmitAt.remove(address)
      }
      peers[id] = record
      addressToPeerId[address] = id
      emitPeer(record, replacesId)
      log("info", "[DISCOVERY] peer discovered ${id.take(8)}")
      if (exchangeIdentity) {
        enqueueWrite(address, identityJson(), packet = false)
      }
    } catch (error: Exception) {
      log("error", "[ERROR] invalid peer identity: ${error.javaClass.simpleName}")
    }
  }

  private fun handleIncoming(device: BluetoothDevice, value: ByteArray) {
    if (isPacketFrame(value)) {
      val peerId = addressToPeerId[device.address] ?: device.address
      ingestFrame(peerId, value)
      return
    }
    try {
      val json = JSONObject(String(value, StandardCharsets.UTF_8))
      val id = json.getString("id").lowercase()
      val name = json.optString("name", "Nored device").take(40)
      val avatarIcon = json.optString("avatarIcon", "").ifEmpty { null }
      val avatarColor = if (json.has("avatarColor")) json.optInt("avatarColor") else null
      UUID.fromString(id)
      val mappedId = addressToPeerId[device.address] ?: device.address
      val existing = peers[id] ?: peers[mappedId] ?: peers[device.address]
      val record = PeerRecord(
        id = id,
        name = name,
        address = device.address,
        rssi = firstRssi(existing, peers[mappedId], peers[device.address]),
        lastSeen = System.currentTimeMillis(),
        nored = true,
        confirmedIdentity = true,
        avatarIcon = avatarIcon ?: existing?.avatarIcon,
        avatarColor = avatarColor ?: existing?.avatarColor,
      )
      val previousId = addressToPeerId[device.address]
      val replacesId = if (previousId != null && previousId != id && peers.containsKey(previousId)) previousId else null
      if (replacesId != null) {
        peers.remove(replacesId)
        lastEmitAt.remove(replacesId)
      }
      peers[id] = record
      addressToPeerId[device.address] = id
      serverDevices[device.address] = device
      emitPeer(record, replacesId)
      log("info", "[DISCOVERY] nored peer ${id.take(8)}")
      gatts[device.address]?.let { requestRssi(it) }
    } catch (error: Exception) {
      log("error", "[ERROR] invalid incoming frame: ${error.javaClass.simpleName}")
    }
  }

  private fun publishIdentityUpdate() {
    if (identityNotifyInFlight) {
      identityPushPending = true
      return
    }
    identityNotifyQueue.clear()
    identitySubscribedAddresses.forEach { address ->
      serverDevices[address]?.let(identityNotifyQueue::add)
    }
    gatts.keys.forEach { address ->
      if (sending) {
        identityPushPending = true
      } else {
        enqueueWrite(address, identityJson(), packet = false)
      }
    }
    if (identityNotifyQueue.isEmpty() && gatts.isEmpty()) {
      log("info", "[DISCOVERY] display name saved; peers will refresh on reconnect")
      return
    }
    if (identityNotifyQueue.isNotEmpty()) {
      log("info", "[DISCOVERY] publishing display name to ${identityNotifyQueue.size} subscriber(s)")
      pumpIdentityUpdates()
    }
  }

  // A BLE link can come up while the initial identity exchange is dropped, leaving a peer
  // connected but never `confirmedIdentity` — the UI hides those. Re-read their identity
  // and re-push ours on a slow cadence so the exchange eventually lands.
  @SuppressLint("MissingPermission")
  private fun refreshUnconfirmedIdentities() {
    // Rebuilding identityNotifyQueue under an in-flight notify would desync the head that
    // serverNotificationSent polls off.
    if (!started || sending || identityNotifyInFlight) return
    gatts.forEach { (address, gatt) ->
      val id = addressToPeerId[address] ?: address
      if (peers[id]?.confirmedIdentity == true) return@forEach
      gatt.getService(SERVICE_UUID)?.getCharacteristic(IDENTITY_UUID)?.let { readIdentity(gatt, it) }
      enqueueWrite(address, identityJson(), packet = false)
    }
    val unconfirmedSubscribers = identitySubscribedAddresses.filter { address ->
      val id = addressToPeerId[address] ?: address
      peers[id]?.confirmedIdentity != true
    }
    if (unconfirmedSubscribers.isEmpty()) return
    identityNotifyQueue.clear()
    unconfirmedSubscribers.forEach { address ->
      serverDevices[address]?.let(identityNotifyQueue::add)
    }
    if (identityNotifyQueue.isNotEmpty()) pumpIdentityUpdates()
  }

  @SuppressLint("MissingPermission")
  private fun pumpIdentityUpdates() {
    if (sending || identityNotifyInFlight) return
    val device = identityNotifyQueue.peek() ?: return
    val characteristic = identityCharacteristic ?: run {
      identityNotifyQueue.clear()
      return
    }
    val value = identityJson()
    identityNotifyInFlight = true
    val queued = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gattServer?.notifyCharacteristicChanged(device, characteristic, false, value) ==
          BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.value = value
        @Suppress("DEPRECATION")
        gattServer?.notifyCharacteristicChanged(device, characteristic, false) == true
      }
    } catch (_: Exception) {
      false
    }
    if (!queued) {
      identityNotifyInFlight = false
      identityNotifyQueue.poll()
      log("warn", "[DISCOVERY] display name update notify could not be queued")
      pumpIdentityUpdates()
      return
    }
    mainHandler.removeCallbacks(identityNotifyTimeout)
    mainHandler.postDelayed(identityNotifyTimeout, 3_000L)
  }

  // pumpSend waits on identityNotifyInFlight; an onNotificationSent that never arrives
  // (central gone mid-notify) must not freeze every packet send behind it.
  private val identityNotifyTimeout = Runnable {
    if (!identityNotifyInFlight) return@Runnable
    identityNotifyInFlight = false
    identityNotifyQueue.poll()
    log("warn", "[DISCOVERY] identity notify timed out")
    pumpIdentityUpdates()
    pumpSend()
  }

  private fun beginSend(peerId: String, packet: String, promise: Promise) {
    if (!started) {
      promise.reject("ERR_STOPPED", "Bluetooth is not running", null)
      return
    }
    if (!hasLiveLink(peerId)) {
      promise.reject("ERR_NOT_CONNECTED", "Peer is not connected over Bluetooth.", null)
      return
    }
    sendToken += 1
    sendQueue.add(SendJob(peerId, packet.toByteArray(StandardCharsets.UTF_8), promise, sendToken))
    pumpSend()
  }

  @SuppressLint("MissingPermission")
  private fun pumpSend() {
    if (sending || identityNotifyInFlight) return
    val job = sendQueue.peek() ?: return
    if (job.route == null) {
      val address = if (job.writeFailed) null else writeAddress(job.peerId)
      val device = if (address == null && !job.notifyFailed) notifyDevice(job.peerId) else null
      val route: SendRoute
      val mtu: Int
      when {
        address != null -> {
          route = SendRoute.Write(address)
          mtu = clientMtuByAddress[address] ?: 23
        }
        device != null -> {
          route = SendRoute.Notify(device.address)
          mtu = serverMtuByAddress[device.address] ?: 23
        }
        else -> {
          failCurrentSend("Peer is not connected over Bluetooth.")
          return
        }
      }
      // ATT can negotiate an MTU of 517, but a characteristic value is still limited to
      // 512 bytes. Android 14 also upgrades the first GATT client to MTU 517 regardless of
      // the requested value, so MTU-3 alone can produce an illegal 514-byte value.
      val maxFrameBytes = min(MAX_ATTRIBUTE_VALUE_BYTES, max(1, mtu - 3))
      val frames = makeFrames(job.payload, max(1, maxFrameBytes - PACKET_HEADER_BYTES)) ?: run {
        failCurrentSend("Message is too large for Bluetooth")
        return
      }
      job.route = route
      job.frames = frames
      job.index = 0
    }
    val route = job.route ?: return
    if (job.index >= job.frames.size) {
      finishCurrentSend(true, null)
      return
    }
    val frame = job.frames[job.index]
    when (route) {
      is SendRoute.Write -> {
        if (gatts[route.address]?.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID) == null) {
          abandonRoute()
          return
        }
        sending = true
        armSendTimeout(job.token, job.index)
        enqueueWrite(route.address, frame, packet = true, token = job.token, index = job.index)
      }
      is SendRoute.Notify -> {
        val device = serverDevices[route.address]?.takeIf { subscribedAddresses.contains(route.address) }
        val tx = txCharacteristic
        val server = gattServer
        if (device == null || tx == null || server == null) {
          abandonRoute()
          return
        }
        sending = true
        val queued = try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(device, tx, true, frame) == BluetoothStatusCodes.SUCCESS
          } else {
            @Suppress("DEPRECATION")
            tx.value = frame
            @Suppress("DEPRECATION")
            server.notifyCharacteristicChanged(device, tx, true)
          }
        } catch (_: Exception) {
          false
        }
        if (queued) {
          armSendTimeout(job.token, job.index)
        } else {
          log("warn", "[MSG] indicate could not be queued")
          abandonRoute()
        }
      }
    }
  }

  private fun armSendTimeout(token: Int, index: Int) {
    clearSendTimeout()
    val timeout = Runnable {
      val job = sendQueue.peek() ?: return@Runnable
      if (!sending || job.token != token || job.index != index) return@Runnable
      log("warn", "[MSG] frame timed out")
      // A frame that never completes means the link is dead: Android will not start the
      // next operation on it either, so tear it down and let the reconnect path replace it.
      when (val route = job.route) {
        is SendRoute.Write -> dropClientLink(route.address)
        is SendRoute.Notify -> dropServerLink(route.address)
        null -> {}
      }
      abandonRoute()
    }
    sendTimeout = timeout
    mainHandler.postDelayed(timeout, 6_000L)
  }

  private fun clearSendTimeout() {
    sendTimeout?.let(mainHandler::removeCallbacks)
    sendTimeout = null
  }

  private fun advanceFrame() {
    clearSendTimeout()
    sending = false
    val job = sendQueue.peek() ?: return
    job.index += 1
    if (job.index >= job.frames.size) {
      finishCurrentSend(true, null)
    } else {
      pumpSend()
    }
  }

  /**
   * The current route stopped working (link lost, write error, or timeout). Mark it dead
   * for this job and let pumpSend pick the other route or fail fast. The packet restarts
   * from frame 0 on the new route: the receiver resets its assembler on seq 0, and the two
   * routes may have different MTUs.
   */
  private fun abandonRoute() {
    clearSendTimeout()
    sending = false
    val job = sendQueue.peek() ?: return
    when (job.route) {
      is SendRoute.Write -> job.writeFailed = true
      is SendRoute.Notify -> job.notifyFailed = true
      null -> {}
    }
    job.route = null
    if (!job.writeFailed || !job.notifyFailed) log("warn", "[MSG] switching Bluetooth path")
    pumpSend()
  }

  private fun writeLinkLost(address: String) {
    val job = sendQueue.peek() ?: return
    if (job.route == SendRoute.Write(address)) abandonRoute()
  }

  private fun notifyLinkLost(address: String) {
    val job = sendQueue.peek() ?: return
    if (job.route == SendRoute.Notify(address)) abandonRoute()
  }

  private fun failCurrentSend(message: String) {
    finishCurrentSend(false, message)
  }

  private fun finishCurrentSend(success: Boolean, message: String?) {
    clearSendTimeout()
    sending = false
    val job = sendQueue.poll() ?: return
    if (success) {
      log("info", "[MSG] sent ${job.frames.size} frame(s)")
      job.promise.resolve(null)
    } else {
      log("error", "[ERROR] send failed: ${message ?: "unknown"}")
      job.promise.reject("ERR_SEND", message, null)
    }
    pumpIdentityUpdates()
    pumpSend()
    if (identityPushPending && !sending) {
      identityPushPending = false
      publishIdentityUpdate()
    }
  }

  private fun failQueuedSends(message: String) {
    clearSendTimeout()
    sending = false
    while (sendQueue.isNotEmpty()) {
      sendQueue.poll()?.promise?.reject("ERR_SEND", message, null)
    }
  }

  private fun enqueueWrite(address: String, data: ByteArray, packet: Boolean, token: Int = 0, index: Int = 0) {
    val queue = writeQueues.getOrPut(address) { ArrayDeque() }
    queue.add(WriteJob(data, packet, token, index))
    drainWrite(address)
  }

  @SuppressLint("MissingPermission")
  private fun drainWrite(address: String) {
    if (writeBusy[address] == true) return
    val job = writeQueues[address]?.peek() ?: return
    val rx = gatts[address]?.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID)
    val gatt = gatts[address]
    if (gatt == null || rx == null) {
      // The link (or its service table) is gone; nothing queued here can complete.
      writeQueues.remove(address)
      writeBusy.remove(address)
      writeLinkLost(address)
      return
    }
    writeBusy[address] = true
    val queued = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gatt.writeCharacteristic(rx, job.data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
      } else {
        @Suppress("DEPRECATION")
        rx.value = job.data
        rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        gatt.writeCharacteristic(rx)
      }
    } catch (error: IllegalArgumentException) {
      log("error", "[ERROR] GATT write rejected ${job.data.size}-byte value: ${error.message}")
      false
    }
    if (queued) return
    writeBusy[address] = false
    // Android allows one GATT operation per link at a time; an identity read or CCCD write
    // in flight makes this return busy. Retry briefly before giving up on the frame.
    job.attempts += 1
    if (job.attempts < 5) {
      mainHandler.postDelayed({ drainWrite(address) }, 150L)
      return
    }
    writeQueues[address]?.poll()
    if (job.packet) {
      val send = sendQueue.peek()
      if (sending && send != null && send.route == SendRoute.Write(address) && send.token == job.token && send.index == job.index) {
        log("warn", "[MSG] write could not be queued")
        abandonRoute()
      }
    } else {
      log("error", "[ERROR] local identity write could not be queued")
    }
    drainWrite(address)
  }

  /** null when the packet needs more than the 255 frames the one-byte sequence allows. */
  private fun makeFrames(payload: ByteArray, maxPayload: Int): List<ByteArray>? {
    val size = max(1, maxPayload)
    val total = max(1, ceil(payload.size / size.toDouble()).toInt())
    if (total > 255) return null
    return (0 until total).map { index ->
      val start = index * size
      val end = min(payload.size, start + size)
      byteArrayOf(PACKET_MAGIC, index.toByte(), total.toByte()) + payload.copyOfRange(start, end)
    }
  }

  private fun isPacketFrame(data: ByteArray): Boolean = data.size >= 3 && data[0] == PACKET_MAGIC

  private fun ingestFrame(peerId: String, data: ByteArray) {
    if (!isPacketFrame(data)) return
    val seq = data[1].toInt() and 0xFF
    val total = data[2].toInt() and 0xFF
    if (total <= 0 || seq >= total) return
    val part = data.copyOfRange(3, data.size)
    val now = System.currentTimeMillis()
    var assembler = assemblers[peerId]
    val stale = assembler != null && now - assembler.startedAt > 2_500L
    if (seq == 0 || assembler == null || assembler.total != total || stale) {
      if (seq != 0) return
      assembler = FrameAssembler(total, mutableMapOf(), now)
    }
    val current = assembler ?: return
    current.parts[seq] = part
    current.startedAt = now
    if (current.parts.size == total) {
      assemblers.remove(peerId)
      val payload = (0 until total).fold(ByteArray(0)) { acc, index ->
        acc + (current.parts[index] ?: return)
      }
      val packet = try {
        String(payload, StandardCharsets.UTF_8)
      } catch (_: Exception) {
        log("error", "[ERROR] invalid packet encoding")
        return
      }
      log("info", "[MSG] received ${payload.size} bytes")
      mainHandler.post {
        sendEvent("onPacketReceived", mapOf("peerId" to peerId, "packet" to packet))
      }
    } else {
      assemblers[peerId] = current
    }
  }

  private fun cccdEnableValue(characteristic: BluetoothGattCharacteristic): ByteArray {
    return if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
      BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
    } else {
      BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    }
  }

  private fun cccdEnabled(value: ByteArray?): Boolean {
    return value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ||
      value.contentEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
  }

  private fun sanitizeRssi(raw: Int?): Int? {
    if (raw == null || raw == 127 || raw > 20 || raw < -127) return null
    return raw
  }

  private fun firstRssi(vararg records: PeerRecord?): Int? {
    return records.mapNotNull { sanitizeRssi(it?.rssi) }.firstOrNull()
  }

  private fun signalBucket(rssi: Int?): Int {
    val value = sanitizeRssi(rssi) ?: return 0
    return when {
      value >= -60 -> 3
      value >= -75 -> 2
      else -> 1
    }
  }

  @SuppressLint("MissingPermission")
  private fun requestRssi(gatt: BluetoothGatt) {
    if (sending || writeBusy[gatt.device.address] == true) return
    try {
      gatt.readRemoteRssi()
    } catch (_: Exception) {}
  }

  @SuppressLint("MissingPermission")
  private fun pollRemoteRssi() {
    gatts.values.forEach { gatt ->
      requestRssi(gatt)
    }
  }

  private fun applyRssi(address: String, raw: Int) {
    val rssi = sanitizeRssi(raw) ?: return
    val peerId = addressToPeerId[address] ?: address
    val peer = peers[peerId] ?: peers[address] ?: return
    val previous = peer.rssi
    if (previous == rssi) return
    val bucketChanged = signalBucket(previous) != signalBucket(rssi)
    peer.rssi = rssi
    if (bucketChanged) {
      lastEmitAt[peer.id] = System.currentTimeMillis()
      emitPeer(peer)
    }
  }

  private fun peerMap(peer: PeerRecord, replacesId: String? = null): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>(
      "id" to peer.id,
      "name" to peer.name,
      "lastSeen" to peer.lastSeen,
      "nored" to peer.nored,
      "identityConfirmed" to peer.confirmedIdentity,
      "connected" to hasLiveLink(peer.id),
    )
    sanitizeRssi(peer.rssi)?.let { map["rssi"] = it }
    if (peer.avatarIcon != null) {
      map["avatarIcon"] = peer.avatarIcon
    }
    if (peer.avatarColor != null) {
      map["avatarColor"] = peer.avatarColor
    }
    if (replacesId != null) {
      map["replacesId"] = replacesId
    }
    return map
  }

  private fun emitPeer(peer: PeerRecord, replacesId: String? = null) = mainHandler.post {
    sendEvent("onPeerDiscovered", peerMap(peer, replacesId))
  }

  private fun emitPeerLost(peerId: String) = mainHandler.post {
    sendEvent("onPeerLost", mapOf("peerId" to peerId))
  }

  private fun emitState(state: String) = mainHandler.post {
    sendEvent("onStateChanged", mapOf("state" to state))
  }

  private fun log(level: String, message: String) {
    Log.println(if (level == "error") Log.ERROR else Log.INFO, TAG, message)
    mainHandler.post {
      sendEvent(
        "onLog",
        mapOf("level" to level, "message" to message, "timestamp" to System.currentTimeMillis()),
      )
    }
  }
}
