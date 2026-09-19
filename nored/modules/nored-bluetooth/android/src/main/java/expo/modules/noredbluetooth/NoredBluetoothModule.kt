package expo.modules.noredbluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
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
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private const val TAG = "NoredBLE"
private const val PREFS = "nored_ble_identity"
private const val DEVICE_ID = "device_id"
private const val DISPLAY_NAME = "display_name"
private const val STALE_PEER_MS = 20_000L

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

class NoredBluetoothModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val peers = ConcurrentHashMap<String, PeerRecord>()
  private val addressToPeerId = ConcurrentHashMap<String, String>()
  private val gatts = ConcurrentHashMap<String, BluetoothGatt>()
  private val connecting = ConcurrentHashMap.newKeySet<String>()
  private var started = false
  private var receiverRegistered = false
  private var originalAdapterName: String? = null
  private var advertiseWithoutName = false

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context is unavailable", null)

  private val bluetoothManager: BluetoothManager?
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private val adapter: BluetoothAdapter?
    get() = bluetoothManager?.adapter

  override fun definition() = ModuleDefinition {
    Name("NoredBluetooth")

    Events("onPeerDiscovered", "onPeerLost", "onStateChanged", "onLog")

    Function("isSupported") {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && adapter != null
    }

    Function("requiredPermissions") { requiredPermissionNames() }
    Function("getIdentity") { identityMap() }
    Function("getPeers") { peers.values.sortedByDescending { it.lastSeen }.map { peerMap(it) } }

    AsyncFunction("setDisplayName") { rawName: String ->
      val name = rawName.trim()
      if (name.isEmpty() || name.length > 40) {
        throw CodedException("ERR_INVALID_NAME", "Display name must be 1 to 40 characters", null)
      }
      preferences().edit().putString(DISPLAY_NAME, name).commit()
      if (started) startAdvertiser()
      identityMap()
    }

    AsyncFunction("start") { startScanning() }
    AsyncFunction("stop") { stopScanning() }

    OnActivityEntersForeground {
      if (started) {
        startScannerOnly()
        startAdvertiser()
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
    var name = prefs.getString(DISPLAY_NAME, null)
    if (name == null) {
      name = Build.MODEL.take(40).ifBlank { "Android" }
      prefs.edit().putString(DISPLAY_NAME, name).apply()
    }
    return mapOf("id" to id, "name" to name)
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
    startScannerOnly()
    startAdvertiser()
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
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .build()
      scanner.startScan(null, settings, scanCallback)
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
    stopAdvertiser(restoreName = false)
    val displayName = (identityMap()["name"] as String).take(11)
    try {
      if (originalAdapterName == null) originalAdapterName = adapter?.name
      adapter?.name = displayName
    } catch (_: Exception) {}
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
    val scanResponse = AdvertiseData.Builder()
      .setIncludeDeviceName(!advertiseWithoutName)
      .build()
    try {
      advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback)
    } catch (error: SecurityException) {
      log("error", "[ERROR] advertiser permission denied")
    } catch (error: Exception) {
      if (!advertiseWithoutName) {
        advertiseWithoutName = true
        startAdvertiser()
      } else {
        log("error", "[ERROR] advertiser failed: ${error.javaClass.simpleName}")
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopAdvertiser(restoreName: Boolean = true) {
    try {
      adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    } catch (_: Exception) {}
    if (restoreName) {
      advertiseWithoutName = false
      try {
        originalAdapterName?.let { adapter?.name = it }
      } catch (_: Exception) {}
      originalAdapterName = null
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      log("info", "[BLE] advertiser started")
    }

    override fun onStartFailure(errorCode: Int) {
      if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE && !advertiseWithoutName) {
        advertiseWithoutName = true
        mainHandler.post { startAdvertiser() }
        return
      }
      log("error", "[ERROR] advertiser failed code=$errorCode")
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopScanning() {
    started = false
    unregisterBluetoothReceiver()
    mainHandler.removeCallbacks(cleanupPeers)
    try {
      if (hasPermissions()) adapter?.bluetoothLeScanner?.stopScan(scanCallback)
    } catch (_: Exception) {}
    stopAdvertiser()
    closeConnections()
    lastEmitAt.clear()
    emitState("stopped")
  }

  private val bluetoothStateReceiver = object : BroadcastReceiver() {
    override fun onReceive(receiverContext: Context?, intent: Intent?) {
      if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
      when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
        BluetoothAdapter.STATE_ON -> {
          log("info", "[BLE] Bluetooth powered on")
          startScannerOnly()
          startAdvertiser()
        }
        BluetoothAdapter.STATE_OFF -> {
          log("warn", "[BLE] Bluetooth powered off")
          stopAdvertiser()
          closeConnections()
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
  private fun closeConnections() {
    gatts.values.forEach { gatt ->
      try {
        gatt.disconnect()
        gatt.close()
      } catch (_: Exception) {}
    }
    gatts.clear()
    connecting.clear()
    peers.keys.toList().forEach(::emitPeerLost)
    peers.clear()
    addressToPeerId.clear()
  }

  private val cleanupPeers = object : Runnable {
    override fun run() {
      if (!started) return
      val cutoff = System.currentTimeMillis() - STALE_PEER_MS
      peers.values.filter { it.lastSeen < cutoff && !gatts.containsKey(it.address) }.forEach {
        peers.remove(it.id)
        addressToPeerId.entries.removeAll { entry -> entry.value == it.id }
        lastEmitAt.remove(it.id)
        emitPeerLost(it.id)
      }
      mainHandler.postDelayed(this, 5_000L)
    }
  }

  private val lastEmitAt = ConcurrentHashMap<String, Long>()

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      if (!started) return
      val address = result.device.address
      val advertisedName = result.scanRecord?.deviceName?.trim()?.takeIf { it.isNotEmpty() }
      val now = System.currentTimeMillis()
      val peerId = addressToPeerId[address] ?: address
      val existing = peers[peerId] ?: peers[address]
      val alreadyNored = existing?.nored == true
      val isNored = alreadyNored || result.scanRecord?.serviceUuids?.any { it.uuid == SERVICE_UUID } == true
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
      if (isNored && !gatts.containsKey(address) && connecting.add(address)) {
        log("info", "[DISCOVERY] Nored advertisement RSSI ${result.rssi}")
        connect(result.device)
      } else if (isNored && nameChanged && existing?.confirmedIdentity == true) {
        gatts[address]?.let { gatt ->
          gatt.getService(SERVICE_UUID)?.getCharacteristic(IDENTITY_UUID)?.let { identity ->
            readIdentity(gatt, identity)
          }
        }
      }
    }

    override fun onScanFailed(errorCode: Int) {
      log("error", "[ERROR] scanner failed code=$errorCode")
      emitState("unknown")
    }
  }

  @SuppressLint("MissingPermission")
  private fun connect(device: BluetoothDevice) {
    try {
      log("info", "[CONNECTION] connecting ${device.address}")
      val gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
      gatts[device.address] = gatt
    } catch (error: Exception) {
      connecting.remove(device.address)
      log("error", "[ERROR] connect failed: ${error.javaClass.simpleName}")
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    @SuppressLint("MissingPermission")
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val address = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        connecting.remove(address)
        gatts[address] = gatt
        log("info", "[CONNECTION] connected $address")
        if (!gatt.requestMtu(185)) gatt.discoverServices()
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        connecting.remove(address)
        gatts.remove(address)
        try { gatt.close() } catch (_: Exception) {}
        log("info", "[CONNECTION] disconnected $address status=$status")
      }
    }

    @SuppressLint("MissingPermission")
    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      log("info", "[CONNECTION] MTU $mtu status=$status")
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
      if (descriptor.uuid == CCCD_UUID) {
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
      if (characteristic.uuid == RX_UUID) {
        if (status == BluetoothGatt.GATT_SUCCESS) {
          log("info", "[DISCOVERY] local identity exchanged")
        } else {
          log("error", "[ERROR] identity write failed status=$status")
        }
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
  private fun receiveIdentity(gatt: BluetoothGatt, bytes: ByteArray) {
    try {
      val json = JSONObject(String(bytes, StandardCharsets.UTF_8))
      val id = json.getString("id")
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
      val rx = gatt.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID)
        ?: throw IllegalStateException("RX characteristic missing")
      val identity = identityJson()
      val queued = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gatt.writeCharacteristic(rx, identity, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
      } else {
        @Suppress("DEPRECATION")
        rx.value = identity
        rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        gatt.writeCharacteristic(rx)
      }
      if (!queued) log("error", "[ERROR] local identity write could not be queued")
    } catch (error: Exception) {
      log("error", "[ERROR] invalid peer identity: ${error.javaClass.simpleName}")
    }
  }

  private fun peerMap(peer: PeerRecord, replacesId: String? = null): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>(
      "id" to peer.id,
      "name" to peer.name,
      "rssi" to peer.rssi,
      "lastSeen" to peer.lastSeen,
      "nored" to peer.nored,
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
