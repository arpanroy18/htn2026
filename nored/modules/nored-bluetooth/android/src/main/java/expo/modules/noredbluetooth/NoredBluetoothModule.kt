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
private const val STALE_PEER_MS = 20_000L
private const val PACKET_MAGIC: Byte = 0x4E
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
)

private data class WriteJob(
  val data: ByteArray,
  val packet: Boolean,
)

private data class SendJob(
  val peerId: String,
  val frames: List<ByteArray>,
  var index: Int,
  val promise: Promise,
  val address: String?,
  val serverDevice: BluetoothDevice?,
)

private data class FrameAssembler(
  val total: Int,
  val parts: MutableMap<Int, ByteArray>,
  val startedAt: Long,
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
  private val identitySubscribedAddresses = ConcurrentHashMap.newKeySet<String>()
  private val clientMtuByAddress = ConcurrentHashMap<String, Int>()
  private val serverMtuByAddress = ConcurrentHashMap<String, Int>()
  private val lastEmitAt = ConcurrentHashMap<String, Long>()
  private var gattServer: BluetoothGattServer? = null
  private var identityCharacteristic: BluetoothGattCharacteristic? = null
  private var txCharacteristic: BluetoothGattCharacteristic? = null
  private var sending = false
  private var sendTimeout: Runnable? = null
  private var ignoredServerNotificationCallbacks = 0
  private val identityNotifyQueue = ArrayDeque<BluetoothDevice>()
  private var identityNotifyInFlight = false
  private var started = false
  private var receiverRegistered = false
  private var keepAliveTicks = 0

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

    AsyncFunction("setDisplayName") { rawName: String ->
      val name = normalizedDisplayName(rawName)
        ?: throw CodedException("ERR_INVALID_NAME", "Display name must be 1 to 40 UTF-8 bytes", null)
      preferences().edit().putString(DISPLAY_NAME, name).commit()
      if (started) publishIdentityUpdate()
      identityMap()
    }

    AsyncFunction("start") { startScanning() }
    AsyncFunction("stop") { stopScanning() }
    AsyncFunction("sendPacket") { peerId: String, packet: String, promise: Promise ->
      mainHandler.post { beginSend(peerId, packet, promise) }
    }

    OnActivityEntersForeground {
      if (started) {
        startScannerOnly()
        startAdvertiser()
        startGattServer()
      }
    }

    OnDestroy { stopScanning() }
  }

  private fun preferences() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

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
    return mapOf("id" to id, "name" to name)
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
      .put("v", 1)
      .put("id", identity.getValue("id"))
      .put("name", identity.getValue("name"))
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
    mainHandler.removeCallbacks(cleanupPeers)
    mainHandler.postDelayed(cleanupPeers, 5_000L)
  }

  @SuppressLint("MissingPermission")
  private fun startScannerOnly() {
    if (!started || !hasPermissions() || adapter?.isEnabled != true) return
    val scanner = adapter?.bluetoothLeScanner ?: run {
      emitState("unsupported")
      return
    }
    try {
      scanner.stopScan(scanCallback)
      scanner.stopScan(noredScanCallback)
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
        .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
        .build()
      scanner.startScan(null, settings, scanCallback)
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
      scanner.startScan(listOf(filter), settings, noredScanCallback)
      log("info", "[BLE] scanner started")
      emitState("running")
    } catch (error: SecurityException) {
      emitState("unauthorized")
      log("error", "[ERROR] scanner permission denied")
    } catch (error: Exception) {
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
      BluetoothGattCharacteristic.PROPERTY_NOTIFY,
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
    if (adapter?.isMultipleAdvertisementSupported != true) {
      log("warn", "[BLE] this phone cannot advertise to other devices")
      return
    }
    val advertiser = adapter?.bluetoothLeAdvertiser ?: run {
      log("warn", "[BLE] advertiser unavailable")
      return
    }
    stopAdvertiser()
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
    try {
      adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    } catch (_: Exception) {}
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      log("info", "[BLE] advertiser started")
    }

    override fun onStartFailure(errorCode: Int) {
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
    writeQueues.clear()
    writeBusy.clear()
    serverDevices.clear()
    subscribedAddresses.clear()
    identitySubscribedAddresses.clear()
    clientMtuByAddress.clear()
    serverMtuByAddress.clear()
    identityNotifyQueue.clear()
    identityNotifyInFlight = false
    assemblers.clear()
    peers.keys.toList().forEach(::emitPeerLost)
    peers.clear()
    addressToPeerId.clear()
  }

  private val cleanupPeers = object : Runnable {
    override fun run() {
      if (!started) return
      val cutoff = System.currentTimeMillis() - STALE_PEER_MS
      peers.values.filter {
        it.lastSeen < cutoff &&
          !gatts.containsKey(it.address) &&
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
      if (keepAliveTicks % 2 == 0) {
        startScannerOnly()
      }
      mainHandler.postDelayed(this, 5_000L)
    }
  }

  private fun connectDelayMs(): Long {
    val id = identityMap()["id"] as String
    val hex = id.takeLast(2).toIntOrNull(16) ?: 0
    return 200L + (hex % 10) * 120L
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
    val isNored = alreadyNored || forceNored || advertisedService
    val fallbackName = existing?.name
      ?: result.device.name?.trim()?.takeIf { it.isNotEmpty() }
      ?: if (isNored) "Nored user" else "Unknown device"
    val displayName = (advertisedName ?: fallbackName).take(40).let {
      if (isNored && it.equals("Unknown device", ignoreCase = true)) "Nored user" else it
    }
    val nameChanged = existing != null && displayName != existing.name
    val record = PeerRecord(
      id = peerId,
      name = displayName,
      address = address,
      rssi = result.rssi,
      lastSeen = now,
      nored = isNored,
      confirmedIdentity = existing?.confirmedIdentity == true,
    )
    if (peerId != address) {
      peers.remove(address)
    }
    peers[peerId] = record
    addressToPeerId[address] = peerId
    val last = lastEmitAt[peerId] ?: 0L
    if (!alreadyNored && isNored || nameChanged || now - last >= 1_000L) {
      lastEmitAt[peerId] = now
      emitPeer(record)
    }
    if (isNored && !gatts.containsKey(address) && !serverDevices.containsKey(address) && connecting.add(address)) {
      if (gatts.size >= MAX_CONNECTIONS) {
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
      log("error", "[ERROR] scanner failed code=$errorCode")
      mainHandler.postDelayed({ if (started) startScannerOnly() }, 2_000L)
    }
  }

  private val noredScanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handleScanResult(result, forceNored = true)
    }

    override fun onScanFailed(errorCode: Int) {
      log("error", "[ERROR] nored scanner failed code=$errorCode")
      mainHandler.postDelayed({ if (started) startScannerOnly() }, 2_000L)
    }
  }

  @SuppressLint("MissingPermission")
  private fun connect(device: BluetoothDevice) {
    try {
      log("info", "[CONNECTION] connecting ${device.address}")
      val gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
      gatts[device.address] = gatt
      val timeout = Runnable {
        if (!connecting.remove(device.address)) return@Runnable
        connectionTimeouts.remove(device.address)
        gatts.remove(device.address)
        try {
          gatt.disconnect()
          gatt.close()
        } catch (_: Exception) {}
        log("warn", "[CONNECTION] connect timed out ${device.address}")
      }
      connectionTimeouts.put(device.address, timeout)?.let(mainHandler::removeCallbacks)
      mainHandler.postDelayed(timeout, 12_000L)
    } catch (error: Exception) {
      connecting.remove(device.address)
      log("error", "[ERROR] connect failed: ${error.javaClass.simpleName}")
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val address = gatt.device.address
      connectionTimeouts.remove(address)?.let(mainHandler::removeCallbacks)
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        connecting.remove(address)
        gatts[address] = gatt
        log("info", "[CONNECTION] connected $address")
        startAdvertiser()
        if (!gatt.requestMtu(185)) gatt.discoverServices()
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
        connecting.remove(address)
        gatts.remove(address)
        clientMtuByAddress.remove(address)
        writeQueues.remove(address)
        writeBusy.remove(address)
        try { gatt.close() } catch (_: Exception) {}
        log("info", "[CONNECTION] disconnected $address status=$status")
        startAdvertiser()
      }
    }

    @SuppressLint("MissingPermission")
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      log("info", "[CONNECTION] MTU $mtu status=$status")
      if (status == BluetoothGatt.GATT_SUCCESS) {
        clientMtuByAddress[gatt.device.address] = mtu
      }
      gatt.discoverServices()
    }

    @SuppressLint("MissingPermission")
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
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
        gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      } else {
        @Suppress("DEPRECATION")
        descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        @Suppress("DEPRECATION")
        gatt.writeDescriptor(descriptor)
      }
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
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
    ) {
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
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU &&
        characteristic.uuid == IDENTITY_UUID && status == BluetoothGatt.GATT_SUCCESS
      ) {
        receiveIdentity(gatt, characteristic.value ?: return)
      }
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (characteristic.uuid != RX_UUID) return
      val address = gatt.device.address
      if (gatts[address] !== gatt) return
      val queue = writeQueues[address]
      val job = queue?.peek()
      if (status != BluetoothGatt.GATT_SUCCESS) {
        log("error", "[ERROR] write failed status=$status")
        queue?.poll()
        writeBusy[address] = false
        if (job?.packet == true) {
          failCurrentSend("Write failed")
        } else {
          log("error", "[ERROR] identity write failed status=$status")
          mainHandler.postDelayed({ enqueueWrite(address, identityJson(), packet = false) }, 400L)
        }
        drainWrite(address)
        return
      }
      queue?.poll()
      writeBusy[address] = false
      if (job?.packet == true) {
        finishCurrentFrame()
      } else {
        log("info", "[DISCOVERY] local identity exchanged")
        subscribeIdentityNotifications(gatt)
      }
      drainWrite(address)
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      if (characteristic.uuid == TX_UUID) {
        val peerId = addressToPeerId[gatt.device.address] ?: gatt.device.address
        ingestFrame(peerId, value)
      } else if (characteristic.uuid == IDENTITY_UUID) {
        receiveIdentity(gatt, value, exchangeIdentity = false)
      }
    }

    @Deprecated("Deprecated in Android 13")
    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && characteristic.uuid == TX_UUID) {
        val peerId = addressToPeerId[gatt.device.address] ?: gatt.device.address
        ingestFrame(peerId, characteristic.value ?: return)
      } else if (
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU &&
        characteristic.uuid == IDENTITY_UUID
      ) {
        receiveIdentity(gatt, characteristic.value ?: return, exchangeIdentity = false)
      }
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        serverDevices[device.address] = device
        log("info", "[CONNECTION] central connected ${device.address}")
        startAdvertiser()
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        serverDevices.remove(device.address)
        subscribedAddresses.remove(device.address)
        identitySubscribedAddresses.remove(device.address)
        serverMtuByAddress.remove(device.address)
        log("info", "[CONNECTION] central disconnected ${device.address}")
        startAdvertiser()
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
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
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      handleIncoming(device, value)
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
      if (descriptor.uuid == CCCD_UUID) {
        val enabled = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        when (descriptor.characteristic.uuid) {
          TX_UUID -> if (enabled) subscribedAddresses.add(device.address) else subscribedAddresses.remove(device.address)
          IDENTITY_UUID -> if (enabled) {
            identitySubscribedAddresses.add(device.address)
            identityNotifyQueue.add(device)
            pumpIdentityUpdates()
          } else {
            identitySubscribedAddresses.remove(device.address)
          }
        }
        if (enabled) serverDevices[device.address] = device
      }
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      if (identityNotifyInFlight) {
        identityNotifyInFlight = false
        identityNotifyQueue.poll()
        if (status != BluetoothGatt.GATT_SUCCESS) {
          log("warn", "[DISCOVERY] display name update notify failed status=$status")
        }
        pumpIdentityUpdates()
        pumpSend()
        return
      }
      if (ignoredServerNotificationCallbacks > 0) {
        ignoredServerNotificationCallbacks -= 1
        return
      }
      if (status == BluetoothGatt.GATT_SUCCESS) {
        finishCurrentFrame()
      } else {
        failCurrentSend("Notify failed")
      }
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
      UUID.fromString(id)
      val address = gatt.device.address
      val previousId = addressToPeerId[address] ?: address
      val existing = peers[id] ?: peers[previousId] ?: peers[address]
      val record = PeerRecord(
        id = id,
        name = name,
        address = address,
        rssi = existing?.rssi,
        lastSeen = System.currentTimeMillis(),
        nored = true,
        confirmedIdentity = true,
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
      UUID.fromString(id)
      val existing = peers[id] ?: peers[addressToPeerId[device.address] ?: device.address]
      val record = PeerRecord(
        id = id,
        name = name,
        address = device.address,
        rssi = existing?.rssi,
        lastSeen = System.currentTimeMillis(),
        nored = true,
        confirmedIdentity = true,
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
    } catch (error: Exception) {
      log("error", "[ERROR] invalid incoming frame: ${error.javaClass.simpleName}")
    }
  }

  private fun publishIdentityUpdate() {
    identityNotifyQueue.clear()
    identitySubscribedAddresses.forEach { address ->
      serverDevices[address]?.let(identityNotifyQueue::add)
    }
    if (identityNotifyQueue.isEmpty()) {
      log("info", "[DISCOVERY] display name saved; peers will refresh on reconnect")
      return
    }
    pumpIdentityUpdates()
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
        gattServer?.notifyCharacteristicChanged(device, characteristic, false, value) == true
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
    }
  }

  private fun beginSend(peerId: String, packet: String, promise: Promise) {
    if (!started) {
      promise.reject("ERR_STOPPED", "Bluetooth is not running", null)
      return
    }
    val peer = peers[peerId]
    val clientAddress = peer?.address?.takeIf { gatts.containsKey(it) }
    val serverDevice = serverDevices.values.firstOrNull { addressToPeerId[it.address] == peerId }
      ?: peer?.address?.let { serverDevices[it] }
    val canNotify = serverDevice != null && subscribedAddresses.contains(serverDevice.address)
    if (clientAddress == null && !canNotify) {
      promise.reject("ERR_NOT_CONNECTED", "Peer is not connected over Bluetooth.", null)
      return
    }
    val mtu = if (clientAddress != null) {
      clientMtuByAddress[clientAddress] ?: 23
    } else {
      serverDevice?.address?.let { serverMtuByAddress[it] } ?: 23
    }
    val maxPayload = max(1, mtu - 6)
    val frames = try {
      makeFrames(packet, maxPayload)
    } catch (error: Exception) {
      promise.reject("ERR_PACKET", error.message, error)
      return
    }
    sendQueue.add(
      SendJob(
        peerId = peerId,
        frames = frames,
        index = 0,
        promise = promise,
        address = clientAddress,
        serverDevice = if (clientAddress == null) serverDevice else null,
      ),
    )
    pumpSend()
  }

  @SuppressLint("MissingPermission")
  private fun pumpSend() {
    if (sending || identityNotifyInFlight) return
    val job = sendQueue.peek() ?: return
    if (job.index >= job.frames.size) {
      finishCurrentSend(true, null)
      return
    }
    val frame = job.frames[job.index]
    sending = true
    if (job.address != null) {
      enqueueWrite(job.address, frame, packet = true)
      return
    }
    val device = job.serverDevice
    val tx = txCharacteristic
    if (device == null || tx == null) {
      failCurrentSend("Peer is not connected over Bluetooth.")
      return
    }
    val notified = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gattServer?.notifyCharacteristicChanged(device, tx, false, frame) == true
      } else {
        @Suppress("DEPRECATION")
        tx.value = frame
        @Suppress("DEPRECATION")
        gattServer?.notifyCharacteristicChanged(device, tx, false) == true
      }
    } catch (error: Exception) {
      false
    }
    if (!notified) {
      failCurrentSend("Notify could not be queued")
    } else {
      armSendTimeout()
    }
  }

  private fun armSendTimeout() {
    sendTimeout?.let(mainHandler::removeCallbacks)
    val timeout = Runnable {
      if (!sending) return@Runnable
      val job = sendQueue.peek()
      if (job?.address != null) {
        val address = job.address
        val gatt = gatts.remove(address)
        writeQueues.remove(address)
        writeBusy.remove(address)
        try {
          gatt?.disconnect()
          gatt?.close()
        } catch (_: Exception) {}
      } else if (job?.serverDevice != null) {
        ignoredServerNotificationCallbacks += 1
        try {
          gattServer?.cancelConnection(job.serverDevice)
        } catch (_: Exception) {}
      }
      failCurrentSend("Bluetooth send timed out")
    }
    sendTimeout = timeout
    mainHandler.postDelayed(timeout, 8_000L)
  }

  private fun clearSendTimeout() {
    sendTimeout?.let(mainHandler::removeCallbacks)
    sendTimeout = null
  }

  private fun finishCurrentFrame() {
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
  }

  private fun failQueuedSends(message: String) {
    clearSendTimeout()
    sending = false
    while (sendQueue.isNotEmpty()) {
      sendQueue.poll()?.promise?.reject("ERR_SEND", message, null)
    }
  }

  private fun enqueueWrite(address: String, data: ByteArray, packet: Boolean) {
    val queue = writeQueues.getOrPut(address) { ArrayDeque() }
    queue.add(WriteJob(data, packet))
    drainWrite(address)
  }

  @SuppressLint("MissingPermission")
  private fun drainWrite(address: String) {
    if (writeBusy[address] == true) return
    val job = writeQueues[address]?.peek() ?: return
    val gatt = gatts[address] ?: return
    val rx = gatt.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID) ?: return
    writeBusy[address] = true
    val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeCharacteristic(rx, job.data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION")
      rx.value = job.data
      rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      @Suppress("DEPRECATION")
      gatt.writeCharacteristic(rx)
    }
    if (!queued) {
      writeBusy[address] = false
      writeQueues[address]?.poll()
      if (job.packet) failCurrentSend("Write could not be queued")
      else log("error", "[ERROR] local identity write could not be queued")
    } else if (job.packet) {
      armSendTimeout()
    }
  }

  private fun makeFrames(packet: String, maxPayload: Int): List<ByteArray> {
    val payload = packet.toByteArray(StandardCharsets.UTF_8)
    val size = max(1, maxPayload)
    val total = max(1, ceil(payload.size / size.toDouble()).toInt())
    if (total > 255) throw CodedException("ERR_PACKET", "Message is too large for Bluetooth", null)
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
    var assembler = assemblers[peerId]
    if (assembler == null || assembler.total != total) {
      assembler = FrameAssembler(total, mutableMapOf(), System.currentTimeMillis())
    }
    assembler.parts[seq] = part
    if (assembler.parts.size == total) {
      assemblers.remove(peerId)
      val payload = (0 until total).fold(ByteArray(0)) { acc, index ->
        acc + (assembler.parts[index] ?: return)
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
      assemblers[peerId] = assembler
    }
  }

  private fun peerMap(peer: PeerRecord, replacesId: String? = null): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>(
      "id" to peer.id,
      "name" to peer.name,
      "rssi" to peer.rssi,
      "lastSeen" to peer.lastSeen,
      "nored" to peer.nored,
      "identityConfirmed" to peer.confirmedIdentity,
    )
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
