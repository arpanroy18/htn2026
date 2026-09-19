import CoreBluetooth
import ExpoModulesCore
import UIKit

private let serviceUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000001")
private let identityUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000002")
private let rxUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000003")
private let txUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000004")
private let deviceIdKey = "nored_ble_device_id"
private let displayNameKey = "nored_ble_display_name"
private let avatarIconKey = "nored_ble_avatar_icon"
private let avatarColorKey = "nored_ble_avatar_color"
private let avatarIcons = ["nearby", "chats", "alerts", "games", "gear", "mic", "image", "send"]
private let avatarColorCount = 9
private let stalePeerMs: Double = 20_000
private let packetMagic: UInt8 = 0x4E
private let maxConnections = 6

private struct PeerRecord {
  var id: String
  var name: String
  var rssi: Int?
  var lastSeen: Double
  var nored: Bool
  var confirmedIdentity: Bool
  var avatarIcon: String?
  var avatarColor: Int?
}

private struct ClientLink {
  var peripheral: CBPeripheral
  var peerId: String?
  var rx: CBCharacteristic?
  var tx: CBCharacteristic?
  var identity: CBCharacteristic?
}

private struct FrameAssembler {
  var total: Int
  var parts: [Int: Data]
  var startedAt: Double
}

private struct PendingSend {
  let peerId: String
  let frames: [Data]
  var index: Int
  var retryCount: Int
  let promise: Promise
  var notifyCentral: CBCentral?
  var writePeripheral: CBPeripheral?
  var writeCharacteristic: CBCharacteristic?
}

private final class NoredPeripheralDelegate: NSObject, CBPeripheralManagerDelegate {
  weak var owner: NoredBluetoothModule?

  init(owner: NoredBluetoothModule) {
    self.owner = owner
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    owner?.peripheralManagerDidUpdateState(peripheral)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    owner?.peripheralManager(peripheral, didAdd: service, error: error)
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    owner?.peripheralManagerDidStartAdvertising(peripheral, error: error)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    owner?.peripheralManager(peripheral, didReceiveRead: request)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    owner?.peripheralManager(peripheral, didReceiveWrite: requests)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    owner?.peripheralManager(peripheral, central: central, didSubscribeTo: characteristic)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    owner?.peripheralManager(peripheral, central: central, didUnsubscribeFrom: characteristic)
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    owner?.peripheralManagerIsReady(toUpdateSubscribers: peripheral)
  }
}

private final class NoredCentralDelegate: NSObject, CBCentralManagerDelegate {
  weak var owner: NoredBluetoothModule?

  init(owner: NoredBluetoothModule) {
    self.owner = owner
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    owner?.centralManagerDidUpdateState(central)
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    owner?.centralManager(central, didDiscover: peripheral, advertisementData: advertisementData, rssi: RSSI)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    owner?.centralManager(central, didConnect: peripheral)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    owner?.centralManager(central, didFailToConnect: peripheral, error: error)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    owner?.centralManager(central, didDisconnectPeripheral: peripheral, error: error)
  }
}

private final class NoredPeripheralClientDelegate: NSObject, CBPeripheralDelegate {
  weak var owner: NoredBluetoothModule?

  init(owner: NoredBluetoothModule) {
    self.owner = owner
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    owner?.peripheral(peripheral, didDiscoverServices: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    owner?.peripheral(peripheral, didDiscoverCharacteristicsFor: service, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    owner?.peripheral(peripheral, didUpdateNotificationStateFor: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    owner?.peripheral(peripheral, didUpdateValueFor: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    owner?.peripheral(peripheral, didWriteValueFor: characteristic, error: error)
  }

  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    owner?.peripheral(peripheral, didModifyServices: invalidatedServices)
  }
}

public final class NoredBluetoothModule: Module {
  private var peripheralManager: CBPeripheralManager?
  private var peripheralDelegate: NoredPeripheralDelegate?
  private var centralManager: CBCentralManager?
  private var noredCentralManager: CBCentralManager?
  private var centralDelegate: NoredCentralDelegate?
  private var peripheralClientDelegate: NoredPeripheralClientDelegate?
  private var identityCharacteristic: CBMutableCharacteristic?
  private var rxCharacteristic: CBMutableCharacteristic?
  private var txCharacteristic: CBMutableCharacteristic?
  private var peers: [String: PeerRecord] = [:]
  private var hardwareIdToPeerId: [String: String] = [:]
  private var lastEmitAt: [String: Double] = [:]
  private var started = false
  private var staleTimer: Timer?
  private var keepAliveTicks = 0
  private var clientLinks: [UUID: ClientLink] = [:]
  private var connectingHardware: Set<UUID> = []
  private var connectionManagerByHardware: [UUID: CBCentralManager] = [:]
  private var peerIdByCentral: [UUID: String] = [:]
  private var centralByPeerId: [String: CBCentral] = [:]
  private var assemblers: [String: FrameAssembler] = [:]
  private var sendQueue: [PendingSend] = []
  private var sending = false
  private var sendTimeout: DispatchWorkItem?
  private var pendingIdentityWrites: Set<UUID> = []
  private var identityPushPending = false

  public func definition() -> ModuleDefinition {
    Name("NoredBluetooth")

    Events("onPeerDiscovered", "onPeerLost", "onStateChanged", "onLog", "onPacketReceived")

    Function("isSupported") {
      #if targetEnvironment(simulator)
      return false
      #else
      return true
      #endif
    }

    Function("requiredPermissions") { [] as [String] }
    Function("getIdentity") { self.identityMap() }
    Function("getPeers") { self.peers.values.sorted { $0.lastSeen > $1.lastSeen }.map { self.peerMap($0) } }

    AsyncFunction("setDisplayName") { (rawName: String) -> [String: Any] in
      guard let name = self.normalizedDisplayName(rawName) else {
        throw Exception(name: "ERR_INVALID_NAME", description: "Display name must be 1 to 40 UTF-8 bytes")
      }
      UserDefaults.standard.set(name, forKey: displayNameKey)
      if self.started {
        if self.sending {
          self.identityPushPending = true
        } else {
          self.publishIdentityUpdate()
          self.writeIdentityToConnectedPeers()
        }
      }
      return self.identityMap()
    }.runOnQueue(.main)

    AsyncFunction("start") {
      self.startBluetooth()
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stopBluetooth()
    }.runOnQueue(.main)

    AsyncFunction("sendPacket") { (peerId: String, packet: String, promise: Promise) in
      self.beginSend(peerId: peerId, packet: packet, promise: promise)
    }.runOnQueue(.main)

    OnAppEntersForeground {
      if self.started {
        self.restartAdvertising()
        self.beginScanningIfReady()
        self.adoptConnectedPeripherals()
      }
    }

    OnDestroy {
      self.stopBluetooth()
    }
  }

  private func stableHash(_ input: String) -> UInt32 {
    var hash: UInt32 = 0
    for scalar in input.unicodeScalars {
      hash = (hash * 31 + scalar.value) & 0xFFFFFFFF
    }
    return hash
  }

  private func avatarProfile(for id: String) -> (icon: String, color: Int) {
    let hash = stableHash(id)
    let icon = avatarIcons[Int(hash % UInt32(avatarIcons.count))]
    let color = Int((hash * 31) % UInt32(avatarColorCount))
    return (icon, color)
  }

  private func ensureAvatarProfile(for id: String) -> (icon: String, color: Int) {
    let defaults = UserDefaults.standard
    if let icon = defaults.string(forKey: avatarIconKey),
       defaults.object(forKey: avatarColorKey) != nil {
      return (icon, defaults.integer(forKey: avatarColorKey))
    }
    let profile = avatarProfile(for: id)
    defaults.set(profile.icon, forKey: avatarIconKey)
    defaults.set(profile.color, forKey: avatarColorKey)
    return profile
  }

  private func identityMap() -> [String: Any] {
    let defaults = UserDefaults.standard
    var id = defaults.string(forKey: deviceIdKey)
    if id == nil {
      id = UUID().uuidString.lowercased()
      defaults.set(id, forKey: deviceIdKey)
    }
    let storedName = defaults.string(forKey: displayNameKey)
    let name = normalizedDisplayName(storedName ?? UIDevice.current.name) ?? "Nored"
    if storedName != name {
      defaults.set(name, forKey: displayNameKey)
    }
    let avatar = ensureAvatarProfile(for: id!)
    return [
      "id": id!,
      "name": name,
      "avatarIcon": avatar.icon,
      "avatarColor": avatar.color,
    ]
  }

  private func normalizedDisplayName(_ rawName: String) -> String? {
    let trimmed = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    var result = ""
    var byteCount = 0
    for character in trimmed {
      let text = String(character)
      let bytes = text.lengthOfBytes(using: .utf8)
      if byteCount + bytes > 40 { break }
      result.append(character)
      byteCount += bytes
    }
    return result.isEmpty ? nil : result
  }

  private func identityData() -> Data {
    let identity = identityMap()
    return (try? JSONSerialization.data(withJSONObject: [
      "v": 2,
      "id": identity["id"]!,
      "name": identity["name"]!,
      "avatarIcon": identity["avatarIcon"]!,
      "avatarColor": identity["avatarColor"]!,
    ])) ?? Data()
  }

  private func startBluetooth() {
    #if targetEnvironment(simulator)
    emitState("unsupported")
    return
    #else
    switch CBManager.authorization {
    case .denied, .restricted:
      emitState("unauthorized")
      return
    default:
      break
    }
    started = true
    emitState("starting")
    if peripheralDelegate == nil {
      peripheralDelegate = NoredPeripheralDelegate(owner: self)
    }
    if peripheralClientDelegate == nil {
      peripheralClientDelegate = NoredPeripheralClientDelegate(owner: self)
    }
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: peripheralDelegate,
        queue: .main,
        options: [CBPeripheralManagerOptionShowPowerAlertKey: true]
      )
    }
    if centralDelegate == nil {
      centralDelegate = NoredCentralDelegate(owner: self)
    }
    if centralManager == nil {
      centralManager = CBCentralManager(
        delegate: centralDelegate,
        queue: .main,
        options: [CBCentralManagerOptionShowPowerAlertKey: false]
      )
    }
    if noredCentralManager == nil {
      noredCentralManager = CBCentralManager(
        delegate: centralDelegate,
        queue: .main,
        options: [CBCentralManagerOptionShowPowerAlertKey: false]
      )
    } else {
      beginScanningIfReady()
    }
    keepAliveTicks = 0
    staleTimer?.invalidate()
    staleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.keepDiscoveryAlive()
    }
    #endif
  }

  private func stopBluetooth() {
    started = false
    staleTimer?.invalidate()
    staleTimer = nil
    keepAliveTicks = 0
    sendTimeout?.cancel()
    sendTimeout = nil
    failQueuedSends("Bluetooth stopped")
    centralManager?.stopScan()
    noredCentralManager?.stopScan()
    for link in clientLinks.values {
      connectionManagerByHardware[link.peripheral.identifier]?.cancelPeripheralConnection(link.peripheral)
    }
    clientLinks.removeAll()
    connectingHardware.removeAll()
    connectionManagerByHardware.removeAll()
    peripheralManager?.stopAdvertising()
    peripheralManager?.removeAllServices()
    identityCharacteristic = nil
    rxCharacteristic = nil
    txCharacteristic = nil
    peers.keys.forEach(emitPeerLost)
    peers.removeAll()
    hardwareIdToPeerId.removeAll()
    lastEmitAt.removeAll()
    peerIdByCentral.removeAll()
    centralByPeerId.removeAll()
    assemblers.removeAll()
    emitState("stopped")
  }

  private func configureServiceIfNeeded() {
    guard started, identityCharacteristic == nil else { return }
    let identity = CBMutableCharacteristic(
      type: identityUUID,
      properties: [.read, .notify],
      value: nil,
      permissions: [.readable]
    )
    let rx = CBMutableCharacteristic(
      type: rxUUID,
      properties: [.write, .writeWithoutResponse],
      value: nil,
      permissions: [.writeable]
    )
    let tx = CBMutableCharacteristic(
      type: txUUID,
      properties: [.notify],
      value: nil,
      permissions: []
    )
    let service = CBMutableService(type: serviceUUID, primary: true)
    service.characteristics = [identity, rx, tx]
    identityCharacteristic = identity
    rxCharacteristic = rx
    txCharacteristic = tx
    peripheralManager?.add(service)
  }

  private func beginAdvertisingIfReady() {
    guard started,
          peripheralManager?.state == .poweredOn,
          identityCharacteristic != nil else { return }
    if peripheralManager?.isAdvertising == true { return }
    startAdvertising()
  }

  private func restartAdvertising() {
    guard started, peripheralManager?.state == .poweredOn, identityCharacteristic != nil else { return }
    peripheralManager?.stopAdvertising()
    startAdvertising()
  }

  private func startAdvertising() {
    // Service UUID only. A local name plus 128-bit UUID does not fit in 31 bytes, and iOS 26 vs 27
    // drop different fields, which made one phone visible while the other was not.
    peripheralManager?.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
    ])
  }

  private func publishIdentityUpdate() {
    guard started, let identityCharacteristic else { return }
    let sent = peripheralManager?.updateValue(
      identityData(),
      for: identityCharacteristic,
      onSubscribedCentrals: nil
    ) ?? false
    if sent {
      log("info", "[DISCOVERY] display name update published")
    } else {
      log("warn", "[DISCOVERY] display name update deferred until reconnect")
    }
  }

  private func beginScanningIfReady() {
    guard started else { return }
    let scanOptions = [CBCentralManagerScanOptionAllowDuplicatesKey: true]
    if centralManager?.state == .poweredOn {
      centralManager?.stopScan()
      centralManager?.scanForPeripherals(withServices: nil, options: scanOptions)
    }
    if noredCentralManager?.state == .poweredOn {
      noredCentralManager?.stopScan()
      noredCentralManager?.scanForPeripherals(withServices: [serviceUUID], options: scanOptions)
    }
    if centralManager?.state == .poweredOn || noredCentralManager?.state == .poweredOn {
      log("info", "[BLE] scanner started")
      emitState("running")
    }
  }

  private func keepDiscoveryAlive() {
    dropStalePeers()
    guard started else { return }
    keepAliveTicks += 1
    if peripheralManager?.state == .poweredOn, identityCharacteristic != nil, peripheralManager?.isAdvertising != true {
      startAdvertising()
    }
    if keepAliveTicks.isMultiple(of: 2) {
      beginScanningIfReady()
    }
    if keepAliveTicks.isMultiple(of: 6), !sending {
      publishIdentityUpdate()
      writeIdentityToConnectedPeers()
    }
    adoptConnectedPeripherals()
  }

  private func adoptConnectedPeripherals() {
    for manager in [noredCentralManager, centralManager].compactMap({ $0 }) where manager.state == .poweredOn {
      for peripheral in manager.retrieveConnectedPeripherals(withServices: [serviceUUID]) {
        connectIfNeeded(peripheral, using: manager)
      }
    }
  }

  private func dropStalePeers() {
    guard started else { return }
    let cutoff = Date().timeIntervalSince1970 * 1000 - stalePeerMs
    let stale = peers.filter { $0.value.lastSeen < cutoff }.map(\.key)
    for id in stale {
      if clientLinks.values.contains(where: { $0.peerId == id }) { continue }
      if centralByPeerId[id] != nil { continue }
      peers.removeValue(forKey: id)
      lastEmitAt.removeValue(forKey: id)
      hardwareIdToPeerId = hardwareIdToPeerId.filter { $0.value != id }
      emitPeerLost(id)
    }
    let assemblerCutoff = Date().timeIntervalSince1970 * 1000 - 10_000
    assemblers = assemblers.filter { $0.value.startedAt >= assemblerCutoff }
  }

  private func advertisementContainsNoredService(
    _ advertisementData: [String: Any],
    central: CBCentralManager
  ) -> Bool {
    if central === noredCentralManager { return true }
    let uuidLists = [
      advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID],
      advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID],
    ]
    return uuidLists.contains { $0?.contains(serviceUUID) == true }
  }

  public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      configureServiceIfNeeded()
      beginAdvertisingIfReady()
    case .poweredOff:
      emitState("poweredOff")
      log("warn", "[BLE] Bluetooth powered off")
    case .unauthorized:
      emitState("unauthorized")
    case .unsupported:
      emitState("unsupported")
    default:
      break
    }
  }

  public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      beginScanningIfReady()
    case .poweredOff:
      emitState("poweredOff")
      log("warn", "[BLE] Bluetooth powered off")
    case .unauthorized:
      emitState("unauthorized")
    case .unsupported:
      emitState("unsupported")
    default:
      emitState("unknown")
    }
  }

  public func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    guard started else { return }
    let hardwareId = peripheral.identifier.uuidString.lowercased()
    let advertisedName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let peerId = hardwareIdToPeerId[hardwareId] ?? hardwareId
    let existing = peers[peerId] ?? peers[hardwareId]
    let alreadyNored = existing?.nored == true
    let isNored = alreadyNored || advertisementContainsNoredService(advertisementData, central: central)
    let resolvedName: String = {
      if let advertisedName, !advertisedName.isEmpty {
        return advertisedName
      }
      if let existingName = existing?.name, !existingName.isEmpty {
        return existingName
      }
      if let gapName = peripheral.name?.trimmingCharacters(in: .whitespacesAndNewlines), !gapName.isEmpty {
        return gapName
      }
      return isNored ? "Nored user" : "Unknown device"
    }()
    let now = Date().timeIntervalSince1970 * 1000
    let rssi = RSSI.intValue == 127 ? existing?.rssi : RSSI.intValue
    let displayName: String = {
      if let advertisedName, !advertisedName.isEmpty {
        return String(advertisedName.prefix(40))
      }
      if let existing, existing.confirmedIdentity {
        return existing.name
      }
      return String(resolvedName.prefix(40))
    }()
    let record = PeerRecord(
      id: peerId,
      name: displayName,
      rssi: rssi,
      lastSeen: now,
      nored: isNored,
      confirmedIdentity: existing?.confirmedIdentity == true
    )
    var replacesId: String?
    if peerId != hardwareId, peers[hardwareId] != nil {
      peers.removeValue(forKey: hardwareId)
      lastEmitAt.removeValue(forKey: hardwareId)
      replacesId = hardwareId
    }
    peers[peerId] = record
    hardwareIdToPeerId[hardwareId] = peerId
    let nameChanged = existing?.name != record.name
    if replacesId == nil, !isNored || alreadyNored, let last = lastEmitAt[peerId], now - last < 1000, !nameChanged {
      // still try connect below
    } else {
      lastEmitAt[peerId] = now
      sendEvent("onPeerDiscovered", peerMap(record, replacesId: replacesId))
    }
    if isNored {
      connectIfNeeded(peripheral, using: central)
    }
  }

  public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectingHardware.remove(peripheral.identifier)
    connectionManagerByHardware[peripheral.identifier] = central
    peripheral.delegate = peripheralClientDelegate
    var link = clientLinks[peripheral.identifier] ?? ClientLink(peripheral: peripheral)
    link.peripheral = peripheral
    clientLinks[peripheral.identifier] = link
    log("info", "[CONNECTION] connected \(peripheral.identifier.uuidString.prefix(8))")
    restartAdvertising()
    peripheral.discoverServices([serviceUUID])
  }

  public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connectingHardware.remove(peripheral.identifier)
    connectionManagerByHardware.removeValue(forKey: peripheral.identifier)
    clientLinks.removeValue(forKey: peripheral.identifier)
    log("error", "[ERROR] connect failed \(error?.localizedDescription ?? "unknown")")
    restartAdvertising()
    scheduleReconnect(peripheral, using: central)
  }

  public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    connectingHardware.remove(peripheral.identifier)
    connectionManagerByHardware.removeValue(forKey: peripheral.identifier)
    clientLinks.removeValue(forKey: peripheral.identifier)
    log("info", "[CONNECTION] disconnected \(peripheral.identifier.uuidString.prefix(8))")
    restartAdvertising()
    if started {
      scheduleReconnect(peripheral, using: central)
    }
  }

  public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let error {
      log("error", "[ERROR] service discovery failed: \(error.localizedDescription)")
      cancelConnection(peripheral)
      return
    }
    guard let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
      log("error", "[ERROR] Nored GATT service missing")
      cancelConnection(peripheral)
      return
    }
    peripheral.discoverCharacteristics([identityUUID, rxUUID, txUUID], for: service)
  }

  public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    if let error {
      log("error", "[ERROR] characteristic discovery failed: \(error.localizedDescription)")
      return
    }
    var link = clientLinks[peripheral.identifier] ?? ClientLink(peripheral: peripheral)
    link.identity = service.characteristics?.first(where: { $0.uuid == identityUUID })
    link.rx = service.characteristics?.first(where: { $0.uuid == rxUUID })
    link.tx = service.characteristics?.first(where: { $0.uuid == txUUID })
    clientLinks[peripheral.identifier] = link
    if let identity = link.identity, identity.properties.contains(.notify) {
      peripheral.setNotifyValue(true, for: identity)
    }
    if let tx = link.tx {
      peripheral.setNotifyValue(true, for: tx)
    } else if let identity = link.identity {
      peripheral.readValue(for: identity)
    }
  }

  public func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    if invalidatedServices.contains(where: { $0.uuid == serviceUUID }) {
      peripheral.discoverServices([serviceUUID])
    }
  }

  public func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    if let error {
      log("error", "[ERROR] notify subscribe failed: \(error.localizedDescription)")
    }
    if let identity = clientLinks[peripheral.identifier]?.identity {
      peripheral.readValue(for: identity)
    }
  }

  public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    if let error {
      log("error", "[ERROR] characteristic update failed: \(error.localizedDescription)")
      return
    }
    guard let value = characteristic.value else { return }
    if characteristic.uuid == identityUUID {
      let first = clientLinks[peripheral.identifier]?.peerId == nil
      receiveIdentity(from: peripheral, data: value)
      if first {
        writeLocalIdentity(to: peripheral)
      }
      return
    }
    if characteristic.uuid == txUUID {
      if isPacketFrame(value) {
        let peerId = clientLinks[peripheral.identifier]?.peerId
          ?? hardwareIdToPeerId[peripheral.identifier.uuidString.lowercased()]
          ?? peripheral.identifier.uuidString.lowercased()
        ingestFrame(peerId: peerId, data: value)
      } else {
        let first = clientLinks[peripheral.identifier]?.peerId == nil
        receiveIdentity(from: peripheral, data: value)
        if first {
          writeLocalIdentity(to: peripheral)
        }
      }
    }
  }

  public func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard clientLinks[peripheral.identifier] != nil else { return }
    if characteristic.uuid == rxUUID {
      if pendingIdentityWrites.remove(peripheral.identifier) != nil {
        if let error {
          log("error", "[ERROR] identity write failed: \(error.localizedDescription)")
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.pendingIdentityWrites.remove(peripheral.identifier)
            self?.writeLocalIdentity(to: peripheral)
          }
        } else {
          log("info", "[DISCOVERY] local identity exchanged")
        }
        if let identity = clientLinks[peripheral.identifier]?.identity,
           identity.properties.contains(.notify),
           !identity.isNotifying {
          peripheral.setNotifyValue(true, for: identity)
        }
        return
      }
      if let error {
        fallbackOrFail(error.localizedDescription)
        return
      }
      finishCurrentFrame()
    }
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didAdd service: CBService,
    error: Error?
  ) {
    if let error {
      log("error", "[ERROR] GATT service setup failed: \(error.localizedDescription)")
      return
    }
    beginAdvertisingIfReady()
  }

  public func peripheralManagerDidStartAdvertising(
    _ peripheral: CBPeripheralManager,
    error: Error?
  ) {
    if let error {
      if (error as NSError).localizedDescription.contains("already started") {
        return
      }
      log("error", "[ERROR] advertiser failed: \(error.localizedDescription)")
      return
    }
    log("info", "[BLE] advertiser started")
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didReceiveRead request: CBATTRequest
  ) {
    guard request.characteristic.uuid == identityUUID else {
      peripheral.respond(to: request, withResult: .requestNotSupported)
      return
    }
    let data = identityData()
    guard request.offset <= data.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = data.subdata(in: request.offset..<data.count)
    peripheral.respond(to: request, withResult: .success)
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didReceiveWrite requests: [CBATTRequest]
  ) {
    for request in requests {
      guard request.characteristic.uuid == rxUUID, let data = request.value else {
        peripheral.respond(to: request, withResult: .requestNotSupported)
        continue
      }
      if isPacketFrame(data) {
        let peerId = peerIdByCentral[request.central.identifier]
          ?? request.central.identifier.uuidString.lowercased()
        ingestFrame(peerId: peerId, data: data)
        peripheral.respond(to: request, withResult: .success)
        continue
      }
      do {
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let id = value?["id"] as? String,
              UUID(uuidString: id) != nil,
              let rawName = value?["name"] as? String else {
          peripheral.respond(to: request, withResult: .unlikelyError)
          continue
        }
        let peerId = id.lowercased()
        let hardwareId = request.central.identifier.uuidString.lowercased()
        let previousId = hardwareIdToPeerId[hardwareId] ?? hardwareId
        peerIdByCentral[request.central.identifier] = peerId
        centralByPeerId[peerId] = request.central
        hardwareIdToPeerId[hardwareId] = peerId
        upsertIdentityPeer(
          id: peerId,
          name: String(rawName.prefix(40)),
          replacing: previousId == peerId ? nil : previousId
        )
        log("info", "[DISCOVERY] nored peer \(String(peerId.prefix(8)))")
        peripheral.respond(to: request, withResult: .success)
      } catch {
        log("error", "[ERROR] invalid peer identity")
        peripheral.respond(to: request, withResult: .unlikelyError)
      }
    }
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    log("info", "[CONNECTION] central subscribed \(central.identifier.uuidString.prefix(8))")
    if characteristic.uuid == identityUUID, let identityCharacteristic {
      _ = peripheral.updateValue(identityData(), for: identityCharacteristic, onSubscribedCentrals: [central])
    }
    restartAdvertising()
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    if characteristic.uuid == txUUID, let peerId = peerIdByCentral.removeValue(forKey: central.identifier) {
      centralByPeerId.removeValue(forKey: peerId)
    }
    log("info", "[CONNECTION] disconnected \(central.identifier.uuidString.prefix(8))")
  }

  public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    publishIdentityUpdate()
    pumpSend()
  }

  private func connectDelay() -> TimeInterval {
    let id = (identityMap()["id"] as? String) ?? "0"
    let hex = UInt(id.suffix(2).filter(\.isHexDigit), radix: 16) ?? 0
    return 0.2 + Double(hex % 10) * 0.12
  }

  private func connectIfNeeded(_ peripheral: CBPeripheral, using manager: CBCentralManager) {
    let hardware = peripheral.identifier
    if clientLinks[hardware] != nil || connectingHardware.contains(hardware) { return }
    if clientLinks.count + connectingHardware.count >= maxConnections { return }
    connectingHardware.insert(hardware)
    connectionManagerByHardware[hardware] = manager
    peripheral.delegate = peripheralClientDelegate
    if peripheral.state == .connected {
      clientLinks[hardware] = ClientLink(peripheral: peripheral)
      log("info", "[CONNECTION] already connected \(hardware.uuidString.prefix(8))")
      peripheral.discoverServices([serviceUUID])
      return
    }
    let delay = connectDelay()
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.started else { return }
      if self.clientLinks[hardware]?.rx != nil || self.clientLinks[hardware]?.identity != nil {
        self.connectingHardware.remove(hardware)
        return
      }
      self.clientLinks[hardware] = ClientLink(peripheral: peripheral)
      self.connectionManagerByHardware[hardware] = manager
      manager.connect(peripheral, options: nil)
    }
  }

  private func scheduleReconnect(_ peripheral: CBPeripheral, using manager: CBCentralManager) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
      guard let self, self.started else { return }
      self.connectIfNeeded(peripheral, using: manager)
    }
  }

  private func cancelConnection(_ peripheral: CBPeripheral) {
    connectionManagerByHardware[peripheral.identifier]?.cancelPeripheralConnection(peripheral)
  }

  private func receiveIdentity(from peripheral: CBPeripheral, data: Data) {
    do {
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      guard let id = value?["id"] as? String,
            UUID(uuidString: id) != nil,
            let rawName = value?["name"] as? String else {
        log("error", "[ERROR] invalid peer identity")
        return
      }
      let peerId = id.lowercased()
      let avatarIcon = value?["avatarIcon"] as? String
      let avatarColor = value?["avatarColor"] as? Int
      var link = clientLinks[peripheral.identifier] ?? ClientLink(peripheral: peripheral)
      link.peerId = peerId
      clientLinks[peripheral.identifier] = link
      let hardwareId = peripheral.identifier.uuidString.lowercased()
      let previousId = hardwareIdToPeerId[hardwareId] ?? hardwareId
      hardwareIdToPeerId[peripheral.identifier.uuidString.lowercased()] = peerId
      upsertIdentityPeer(
        id: peerId,
        name: String(rawName.prefix(40)),
        avatarIcon: avatarIcon,
        avatarColor: avatarColor,
        replacing: previousId == peerId ? nil : previousId
      )
      log("info", "[DISCOVERY] peer discovered \(peerId.prefix(8))")
    } catch {
      log("error", "[ERROR] invalid peer identity")
    }
  }

  private func writeIdentityToConnectedPeers() {
    guard !sending else { return }
    pendingIdentityWrites.removeAll()
    for link in clientLinks.values {
      writeLocalIdentity(to: link.peripheral)
    }
  }

  private func writeLocalIdentity(to peripheral: CBPeripheral) {
    guard let rx = clientLinks[peripheral.identifier]?.rx else { return }
    guard pendingIdentityWrites.insert(peripheral.identifier).inserted else { return }
    peripheral.writeValue(identityData(), for: rx, type: .withResponse)
  }

  private func beginSend(peerId: String, packet: String, promise: Promise) {
    guard started else {
      promise.reject("ERR_STOPPED", "Bluetooth is not running")
      return
    }
    let notifyCentral = centralByPeerId[peerId]
    let link = clientLinks.values.first(where: { $0.peerId == peerId })
    let canWrite = link?.peripheral != nil && link?.rx != nil
    let writePeripheral = canWrite ? link?.peripheral : nil
    let writeCharacteristic = canWrite ? link?.rx : nil
    guard notifyCentral != nil || canWrite else {
      promise.reject("ERR_NOT_CONNECTED", "Peer is not connected over Bluetooth.")
      return
    }
    let maxPayload: Int = {
      if let writePeripheral {
        return max(1, writePeripheral.maximumWriteValueLength(for: .withResponse) - 3)
      }
      if let notifyCentral {
        return max(1, notifyCentral.maximumUpdateValueLength - 3)
      }
      return 17
    }()
    do {
      let frames = try makeFrames(packet: packet, maxPayload: maxPayload)
      sendQueue.append(
        PendingSend(
          peerId: peerId,
          frames: frames,
          index: 0,
          retryCount: 0,
          promise: promise,
          notifyCentral: notifyCentral,
          writePeripheral: writePeripheral,
          writeCharacteristic: writeCharacteristic
        )
      )
      pumpSend()
    } catch {
      promise.reject("ERR_PACKET", error.localizedDescription)
    }
  }

  private func pumpSend() {
    guard !sending, let current = sendQueue.first else { return }
    guard current.index < current.frames.count else {
      finishCurrentSend(success: true, message: nil)
      return
    }
    let frame = current.frames[current.index]
    sending = true
    if let tx = txCharacteristic, let central = current.notifyCentral {
      let ok = peripheralManager?.updateValue(frame, for: tx, onSubscribedCentrals: [central]) ?? false
      if ok {
        finishCurrentFrame()
        return
      }
      sendQueue[0].retryCount += 1
      if sendQueue[0].retryCount <= 3 {
        sending = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
          self?.pumpSend()
        }
        return
      }
      sendQueue[0].notifyCentral = nil
      sendQueue[0].retryCount = 0
      log("warn", "[MSG] notify path failed, retrying over write")
    }
    if let peripheral = sendQueue.first?.writePeripheral, let characteristic = sendQueue.first?.writeCharacteristic {
      armSendTimeout(peerId: current.peerId, frameIndex: current.index)
      peripheral.writeValue(frame, for: characteristic, type: .withResponse)
      return
    }
    failCurrentSend("Peer is not connected over Bluetooth.")
  }

  private func armSendTimeout(peerId: String, frameIndex: Int) {
    sendTimeout?.cancel()
    let timeout = DispatchWorkItem { [weak self] in
      guard let self,
            self.sending,
            self.sendQueue.first?.peerId == peerId,
            self.sendQueue.first?.index == frameIndex else { return }
      if let peripheral = self.sendQueue.first?.writePeripheral {
        self.cancelConnection(peripheral)
        self.clientLinks.removeValue(forKey: peripheral.identifier)
        self.connectingHardware.remove(peripheral.identifier)
        self.connectionManagerByHardware.removeValue(forKey: peripheral.identifier)
      }
      self.fallbackOrFail("Bluetooth write timed out")
    }
    sendTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
  }

  private func finishCurrentFrame() {
    sendTimeout?.cancel()
    sendTimeout = nil
    sending = false
    guard !sendQueue.isEmpty else { return }
    sendQueue[0].index += 1
    sendQueue[0].retryCount = 0
    if sendQueue[0].index >= sendQueue[0].frames.count {
      finishCurrentSend(success: true, message: nil)
    } else {
      pumpSend()
    }
  }

  private func fallbackOrFail(_ message: String) {
    sendTimeout?.cancel()
    sendTimeout = nil
    sending = false
    guard !sendQueue.isEmpty else { return }
    if sendQueue[0].writePeripheral != nil, sendQueue[0].notifyCentral != nil {
      sendQueue[0].writePeripheral = nil
      sendQueue[0].writeCharacteristic = nil
      log("warn", "[MSG] write path failed, retrying over notify")
      pumpSend()
      return
    }
    failCurrentSend(message)
  }

  private func failCurrentSend(_ message: String) {
    finishCurrentSend(success: false, message: message)
  }

  private func finishCurrentSend(success: Bool, message: String?) {
    sendTimeout?.cancel()
    sendTimeout = nil
    sending = false
    guard !sendQueue.isEmpty else { return }
    let job = sendQueue.removeFirst()
    if success {
      log("info", "[MSG] sent \(job.frames.count) frame(s)")
      job.promise.resolve()
    } else {
      log("error", "[ERROR] send failed: \(message ?? "unknown")")
      job.promise.reject("ERR_SEND", message ?? "Send failed")
    }
    pumpSend()
    if identityPushPending, !sending {
      identityPushPending = false
      publishIdentityUpdate()
      writeIdentityToConnectedPeers()
    }
  }

  private func failQueuedSends(_ message: String) {
    sendTimeout?.cancel()
    sendTimeout = nil
    sending = false
    let jobs = sendQueue
    sendQueue.removeAll()
    for job in jobs {
      job.promise.reject("ERR_SEND", message)
    }
  }

  private func makeFrames(packet: String, maxPayload: Int) throws -> [Data] {
    guard let payload = packet.data(using: .utf8) else {
      throw Exception(name: "ERR_PACKET", description: "Message could not be encoded")
    }
    let size = max(1, maxPayload)
    let total = max(1, Int(ceil(Double(payload.count) / Double(size))))
    guard total <= 255 else {
      throw Exception(name: "ERR_PACKET", description: "Message is too large for Bluetooth")
    }
    return (0..<total).map { index in
      let start = index * size
      let end = min(payload.count, start + size)
      var frame = Data([packetMagic, UInt8(index), UInt8(total)])
      frame.append(payload.subdata(in: start..<end))
      return frame
    }
  }

  private func isPacketFrame(_ data: Data) -> Bool {
    data.count >= 3 && data[0] == packetMagic
  }

  private func ingestFrame(peerId: String, data: Data) {
    guard isPacketFrame(data) else { return }
    let seq = Int(data[1])
    let total = Int(data[2])
    guard total > 0, seq < total else { return }
    let part = data.subdata(in: 3..<data.count)
    var assembler = assemblers[peerId] ?? FrameAssembler(
      total: total,
      parts: [:],
      startedAt: Date().timeIntervalSince1970 * 1000
    )
    if assembler.total != total {
      assembler = FrameAssembler(total: total, parts: [:], startedAt: Date().timeIntervalSince1970 * 1000)
    }
    assembler.parts[seq] = part
    if assembler.parts.count == total {
      assemblers.removeValue(forKey: peerId)
      var payload = Data()
      for index in 0..<total {
        guard let next = assembler.parts[index] else { return }
        payload.append(next)
      }
      guard let packet = String(data: payload, encoding: .utf8) else {
        log("error", "[ERROR] invalid packet encoding")
        return
      }
      log("info", "[MSG] received \(payload.count) bytes")
      sendEvent("onPacketReceived", ["peerId": peerId, "packet": packet])
    } else {
      assemblers[peerId] = assembler
    }
  }

  private func upsertIdentityPeer(
    id: String,
    name: String,
    avatarIcon: String? = nil,
    avatarColor: Int? = nil,
    replacing requestedReplacement: String? = nil
  ) {
    let now = Date().timeIntervalSince1970 * 1000
    let replacesId = requestedReplacement.flatMap { peers[$0] == nil ? nil : $0 }
    if let oldId = replacesId, oldId != id {
      let previous = peers.removeValue(forKey: oldId)
      lastEmitAt.removeValue(forKey: oldId)
      for (hardwareId, peerId) in hardwareIdToPeerId where peerId == oldId {
        hardwareIdToPeerId[hardwareId] = id
      }
      peers[id] = PeerRecord(
        id: id,
        name: name,
        rssi: previous?.rssi,
        lastSeen: now,
        nored: true,
        confirmedIdentity: true,
        avatarIcon: avatarIcon ?? previous?.avatarIcon,
        avatarColor: avatarColor ?? previous?.avatarColor
      )
    } else {
      let existing = peers[id]
      peers[id] = PeerRecord(
        id: id,
        name: name,
        rssi: existing?.rssi,
        lastSeen: now,
        nored: true,
        confirmedIdentity: true,
        avatarIcon: avatarIcon ?? existing?.avatarIcon,
        avatarColor: avatarColor ?? existing?.avatarColor
      )
    }
    lastEmitAt[id] = now
    sendEvent("onPeerDiscovered", peerMap(peers[id]!, replacesId: replacesId == id ? nil : replacesId))
  }

  private func peerMap(_ peer: PeerRecord, replacesId: String? = nil) -> [String: Any] {
    var map: [String: Any] = [
      "id": peer.id,
      "name": peer.name,
      "lastSeen": peer.lastSeen,
      "nored": peer.nored,
      "identityConfirmed": peer.confirmedIdentity,
    ]
    if let rssi = peer.rssi {
      map["rssi"] = rssi
    }
    if let avatarIcon = peer.avatarIcon {
      map["avatarIcon"] = avatarIcon
    }
    if let avatarColor = peer.avatarColor {
      map["avatarColor"] = avatarColor
    }
    if let replacesId {
      map["replacesId"] = replacesId
    }
    return map
  }

  private func emitPeerLost(_ peerId: String) {
    sendEvent("onPeerLost", ["peerId": peerId])
  }

  private func emitState(_ state: String) {
    sendEvent("onStateChanged", ["state": state])
  }

  private func log(_ level: String, _ message: String) {
    NSLog("NoredBLE %@", message)
    sendEvent("onLog", [
      "level": level,
      "message": message,
      "timestamp": Date().timeIntervalSince1970 * 1000
    ])
  }
}
