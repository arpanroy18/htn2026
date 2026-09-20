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
private let stalePeerMs: Double = 45_000
private let staleBluetoothPeerMs: Double = 90_000
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

// A packet can travel over either of the two links we may hold with a peer: a write to
// the peer's RX characteristic over our client link, or an indication on our TX
// characteristic to the peer's subscribed central. The route is chosen when the job
// reaches the head of the queue (never captured at enqueue time), so a link that died
// while the job waited is skipped instead of costing a timeout, and frames are cut to
// the MTU of the route actually used.
private enum SendRoute: Equatable {
  case write(UUID)
  case notify(UUID)
}

/// One outstanding write-with-response to a peer's RX characteristic, in issue order.
private enum RxWrite {
  case identity
  case frame(token: Int, index: Int)
}

private struct PendingSend {
  let peerId: String
  let payload: Data
  let promise: Promise
  let token: Int
  var frames: [Data] = []
  var index = 0
  var route: SendRoute?
  var writeFailed = false
  var notifyFailed = false
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

  func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
    owner?.peripheral(peripheral, didReadRSSI: RSSI, error: error)
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
  private var txSubscribedCentrals: Set<UUID> = []
  private var assemblers: [String: FrameAssembler] = [:]
  private var sendQueue: [PendingSend] = []
  private var sending = false
  private var sendTimeout: DispatchWorkItem?
  private var sendToken = 0
  private var inflightWrite: (hardware: UUID, token: Int, index: Int)?
  private var pendingIdentityWrites: Set<UUID> = []
  /// Identity and packet frames both write to RX, and CoreBluetooth reports completions
  /// in issue order without saying which write finished. Attributing by order keeps an
  /// identity re-exchange from swallowing a frame's completion (which stalled the send
  /// until the timeout dropped the link).
  private var writeOrder: [UUID: [RxWrite]] = [:]
  private var identityPushPending = false
  private var reconnectAttempts: [UUID: Int] = [:]
  private var reconnectWork: [UUID: DispatchWorkItem] = [:]

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
      hash = hash &* 31 &+ scalar.value
    }
    return hash
  }

  private func avatarProfile(for id: String) -> (icon: String, color: Int) {
    let hash = stableHash(id)
    let icon = avatarIcons[Int(hash % UInt32(avatarIcons.count))]
    let color = Int((hash &* 31) % UInt32(avatarColorCount))
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
    reconnectAttempts.removeAll()
    reconnectWork.values.forEach { $0.cancel() }
    reconnectWork.removeAll()
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
    failQueuedSends("Bluetooth stopped")
    centralManager?.stopScan()
    noredCentralManager?.stopScan()
    for link in clientLinks.values {
      connectionManagerByHardware[link.peripheral.identifier]?.cancelPeripheralConnection(link.peripheral)
    }
    clientLinks.removeAll()
    connectingHardware.removeAll()
    connectionManagerByHardware.removeAll()
    reconnectAttempts.removeAll()
    reconnectWork.values.forEach { $0.cancel() }
    reconnectWork.removeAll()
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
    txSubscribedCentrals.removeAll()
    pendingIdentityWrites.removeAll()
    writeOrder.removeAll()
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
      properties: [.indicate],
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
      // The indication queue is full (a transfer is running); retry once it drains.
      identityPushPending = true
      log("warn", "[DISCOVERY] display name update deferred")
    }
  }

  /// Slots consumed by live and pending client links. A hardware id sits in both
  /// `clientLinks` and `connectingHardware` while its connect is pending; counting it
  /// twice made three simultaneous connects look like a full budget of six.
  private func linkBudgetUsed() -> Int {
    Set(clientLinks.keys).union(connectingHardware).count
  }

  private func writeLink(for peerId: String) -> ClientLink? {
    clientLinks.values.first {
      $0.peerId == peerId && $0.rx != nil && $0.peripheral.state == .connected
    }
  }

  private func notifyCentral(for peerId: String) -> CBCentral? {
    guard txCharacteristic != nil, peripheralManager?.state == .poweredOn,
          let central = centralByPeerId[peerId],
          txSubscribedCentrals.contains(central.identifier) else { return nil }
    return central
  }

  private func hasLiveLink(_ peerId: String) -> Bool {
    writeLink(for: peerId) != nil || notifyCentral(for: peerId) != nil
  }

  private func beginScanningIfReady(restart: Bool = false) {
    guard started else { return }
    let scanOptions = [CBCentralManagerScanOptionAllowDuplicatesKey: true]
    var startedScan = false
    if centralManager?.state == .poweredOn {
      if restart || centralManager?.isScanning != true {
        centralManager?.stopScan()
        centralManager?.scanForPeripherals(withServices: nil, options: scanOptions)
        startedScan = true
      }
    }
    if noredCentralManager?.state == .poweredOn {
      if restart || noredCentralManager?.isScanning != true {
        noredCentralManager?.stopScan()
        noredCentralManager?.scanForPeripherals(withServices: [serviceUUID], options: scanOptions)
        startedScan = true
      }
    }
    if centralManager?.state == .poweredOn || noredCentralManager?.state == .poweredOn {
      if startedScan {
        log("info", "[BLE] scanner started")
      }
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
    let restartScanEvery = clientLinks.isEmpty ? 12 : 24
    if keepAliveTicks.isMultiple(of: restartScanEvery) {
      beginScanningIfReady(restart: true)
    } else {
      beginScanningIfReady()
    }
    if keepAliveTicks.isMultiple(of: 4) {
      pollRemoteRssi()
    }
    if (keepAliveTicks + 2).isMultiple(of: 4) {
      refreshUnconfirmedIdentities()
    }
    touchConnectedPeers()
    adoptConnectedPeripherals()
  }

  private func adoptConnectedPeripherals() {
    for manager in [noredCentralManager, centralManager].compactMap({ $0 }) where manager.state == .poweredOn {
      for peripheral in manager.retrieveConnectedPeripherals(withServices: [serviceUUID]) {
        connectIfNeeded(peripheral, using: manager)
      }
    }
  }

  private func hardwareIds(matching peerId: String) -> Bool {
    if clientLinks.contains(where: { $0.key.uuidString.lowercased() == peerId || $0.value.peerId == peerId }) {
      return true
    }
    if connectingHardware.contains(where: { $0.uuidString.lowercased() == peerId }) {
      return true
    }
    if let hardware = hardwareIdToPeerId.first(where: { $0.value == peerId })?.key,
       clientLinks.keys.contains(where: { $0.uuidString.lowercased() == hardware }) {
      return true
    }
    return centralByPeerId[peerId] != nil
  }

  private func touchConnectedPeers() {
    let now = Date().timeIntervalSince1970 * 1000
    for link in clientLinks.values {
      let hardwareId = link.peripheral.identifier.uuidString.lowercased()
      let id = link.peerId ?? hardwareIdToPeerId[hardwareId] ?? hardwareId
      guard var peer = peers[id] else { continue }
      peer.lastSeen = now
      peers[id] = peer
    }
    for peerId in centralByPeerId.keys {
      guard var peer = peers[peerId] else { continue }
      peer.lastSeen = now
      peers[peerId] = peer
    }
  }

  // A BLE link can come up while the initial identity exchange is dropped, leaving a peer
  // connected but never `confirmedIdentity` — the UI hides those. Re-push our identity to
  // any connected-but-unconfirmed peer on a slow cadence so the exchange eventually lands.
  private func refreshUnconfirmedIdentities() {
    guard started, !sending else { return }
    for link in clientLinks.values {
      let hardwareId = link.peripheral.identifier.uuidString.lowercased()
      let id = link.peerId ?? hardwareIdToPeerId[hardwareId] ?? hardwareId
      if peers[id]?.confirmedIdentity == true { continue }
      writeLocalIdentity(to: link.peripheral)
    }
    let centralNeedsIdentity = centralByPeerId.contains { peers[$0.key]?.confirmedIdentity != true }
    if centralNeedsIdentity {
      publishIdentityUpdate()
    }
  }

  private func dropStalePeers() {
    guard started else { return }
    let cutoffNored = Date().timeIntervalSince1970 * 1000 - stalePeerMs
    let cutoffBluetooth = Date().timeIntervalSince1970 * 1000 - staleBluetoothPeerMs
    let stale = peers.filter { _, peer in
      peer.lastSeen < (peer.nored ? cutoffNored : cutoffBluetooth)
    }.map(\.key)
    for id in stale {
      if hardwareIds(matching: id) { continue }
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
      if let existing, existing.confirmedIdentity, !existing.name.isEmpty {
        return existing.name
      }
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
    let rssi = sanitizedRssi(RSSI.intValue) ?? existing?.rssi
    let displayName = String(resolvedName.prefix(40))
    let record = PeerRecord(
      id: peerId,
      name: displayName,
      rssi: rssi,
      lastSeen: now,
      nored: isNored,
      confirmedIdentity: existing?.confirmedIdentity == true,
      avatarIcon: existing?.avatarIcon,
      avatarColor: existing?.avatarColor
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
    let noredChanged = existing?.nored != record.nored
    let bucketChanged = signalBucket(rssi) != signalBucket(existing?.rssi)
    let shouldEmit = existing == nil || replacesId != nil || nameChanged || noredChanged || bucketChanged
    if shouldEmit {
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
    reconnectAttempts[peripheral.identifier] = 0
    reconnectWork.removeValue(forKey: peripheral.identifier)?.cancel()
    peripheral.delegate = peripheralClientDelegate
    var link = clientLinks[peripheral.identifier] ?? ClientLink(peripheral: peripheral)
    link.peripheral = peripheral
    clientLinks[peripheral.identifier] = link
    log("info", "[CONNECTION] connected \(peripheral.identifier.uuidString.prefix(8))")
    beginAdvertisingIfReady()
    peripheral.readRSSI()
    peripheral.discoverServices([serviceUUID])
  }

  public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connectingHardware.remove(peripheral.identifier)
    connectionManagerByHardware.removeValue(forKey: peripheral.identifier)
    clientLinks.removeValue(forKey: peripheral.identifier)
    pendingIdentityWrites.remove(peripheral.identifier)
    writeOrder.removeValue(forKey: peripheral.identifier)
    log("error", "[ERROR] connect failed \(error?.localizedDescription ?? "unknown")")
    beginAdvertisingIfReady()
    writeLinkLost(peripheral.identifier)
    scheduleReconnect(peripheral, using: central)
  }

  public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    connectingHardware.remove(peripheral.identifier)
    connectionManagerByHardware.removeValue(forKey: peripheral.identifier)
    let lostPeerId = clientLinks.removeValue(forKey: peripheral.identifier)?.peerId
    pendingIdentityWrites.remove(peripheral.identifier)
    writeOrder.removeValue(forKey: peripheral.identifier)
    log("info", "[CONNECTION] disconnected \(peripheral.identifier.uuidString.prefix(8))")
    beginAdvertisingIfReady()
    writeLinkLost(peripheral.identifier)
    if let lostPeerId {
      emitLinkStateIfKnown(lostPeerId)
    }
    if started {
      scheduleReconnect(peripheral, using: central)
    }
  }

  /// Tell JS a confirmed peer's link state changed, so the router can retry queued
  /// traffic the moment a link comes back rather than waiting out its backoff.
  private func emitLinkStateIfKnown(_ peerId: String) {
    guard let peer = peers[peerId], peer.confirmedIdentity else { return }
    sendEvent("onPeerDiscovered", peerMap(peer))
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
    guard characteristic.uuid == rxUUID else { return }
    guard var order = writeOrder[peripheral.identifier], !order.isEmpty else { return }
    let completed = order.removeFirst()
    writeOrder[peripheral.identifier] = order
    switch completed {
    case .identity:
      pendingIdentityWrites.remove(peripheral.identifier)
      if let error {
        log("error", "[ERROR] identity write failed: \(error.localizedDescription)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
          guard let self, self.clientLinks[peripheral.identifier] != nil else { return }
          self.writeLocalIdentity(to: peripheral)
        }
      } else {
        log("info", "[DISCOVERY] local identity exchanged")
      }
      if let identity = clientLinks[peripheral.identifier]?.identity,
         identity.properties.contains(.notify),
         !identity.isNotifying {
        peripheral.setNotifyValue(true, for: identity)
      }
    case .frame(let token, let index):
      // Only the frame we are actually waiting on may advance the queue. A response that
      // arrives after its frame timed out (and the job moved on) must be ignored, or it
      // would advance a different job's frame counter and corrupt that packet.
      guard sending,
            let inflight = inflightWrite,
            inflight.hardware == peripheral.identifier,
            inflight.token == token, inflight.index == index,
            let job = sendQueue.first,
            job.token == token, job.index == index else { return }
      if let error {
        log("warn", "[MSG] write failed: \(error.localizedDescription)")
        abandonRoute()
        return
      }
      advanceFrame()
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
        // After a reconnect the central may write frames before its identity write lands;
        // the hardware mapping from the previous session still names it correctly.
        let hardwareId = request.central.identifier.uuidString.lowercased()
        let peerId = peerIdByCentral[request.central.identifier]
          ?? hardwareIdToPeerId[hardwareId]
          ?? hardwareId
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
      if !peripheral.updateValue(identityData(), for: identityCharacteristic, onSubscribedCentrals: [central]) {
        identityPushPending = true
      }
    }
    if characteristic.uuid == txUUID {
      txSubscribedCentrals.insert(central.identifier)
      if let peerId = peerIdByCentral[central.identifier] {
        centralByPeerId[peerId] = central
        emitLinkStateIfKnown(peerId)
      }
    }
    beginAdvertisingIfReady()
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == txUUID else { return }
    txSubscribedCentrals.remove(central.identifier)
    if let peerId = peerIdByCentral.removeValue(forKey: central.identifier) {
      if centralByPeerId[peerId]?.identifier == central.identifier {
        centralByPeerId.removeValue(forKey: peerId)
      }
      emitLinkStateIfKnown(peerId)
    }
    notifyLinkLost(central.identifier)
    log("info", "[CONNECTION] central unsubscribed \(central.identifier.uuidString.prefix(8))")
  }

  public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    // Only a job parked on a full indication queue is waiting for this; a write in
    // flight over a client link must keep its `sending` state.
    if sending, let job = sendQueue.first, case .notify? = job.route {
      sending = false
      pumpSend()
    }
    if identityPushPending, !sending {
      identityPushPending = false
      publishIdentityUpdate()
    }
  }

  private func connectDelay() -> TimeInterval {
    let id = (identityMap()["id"] as? String) ?? "0"
    let hex = UInt(id.suffix(2).filter(\.isHexDigit), radix: 16) ?? 0
    return 0.2 + Double(hex % 10) * 0.12
  }

  private func connectIfNeeded(_ peripheral: CBPeripheral, using manager: CBCentralManager) {
    let hardware = peripheral.identifier
    if clientLinks[hardware] != nil || connectingHardware.contains(hardware) { return }
    if linkBudgetUsed() >= maxConnections { return }
    connectingHardware.insert(hardware)
    connectionManagerByHardware[hardware] = manager
    peripheral.delegate = peripheralClientDelegate
    if peripheral.state == .connected {
      connectingHardware.remove(hardware)
      clientLinks[hardware] = ClientLink(peripheral: peripheral)
      log("info", "[CONNECTION] already connected \(hardware.uuidString.prefix(8))")
      peripheral.discoverServices([serviceUUID])
      return
    }
    let delay = connectDelay()
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      guard self.started else {
        self.connectingHardware.remove(hardware)
        return
      }
      if self.clientLinks[hardware]?.rx != nil || self.clientLinks[hardware]?.identity != nil {
        self.connectingHardware.remove(hardware)
        return
      }
      self.clientLinks[hardware] = ClientLink(peripheral: peripheral)
      self.connectionManagerByHardware[hardware] = manager
      // A plain connect already persists until the peripheral is in range; the system
      // auto-reconnect option only raced our own reconnect scheduling.
      manager.connect(peripheral, options: nil)
    }
  }

  private func scheduleReconnect(_ peripheral: CBPeripheral, using manager: CBCentralManager) {
    reconnectWork.removeValue(forKey: peripheral.identifier)?.cancel()
    // Never let reconnect attempts starve the connection budget: if every slot is spoken
    // for by live links or pending connects, a fresh nearby peer can't get in. Drop this
    // reconnect and let scanning rediscover the peer when a slot frees up.
    if clientLinks[peripheral.identifier] == nil,
       linkBudgetUsed() >= maxConnections {
      reconnectAttempts.removeValue(forKey: peripheral.identifier)
      return
    }
    let attempt = reconnectAttempts[peripheral.identifier] ?? 0
    if attempt >= 10 { return }
    reconnectAttempts[peripheral.identifier] = attempt + 1
    let delay = min(8.0, 1.2 * pow(1.6, Double(min(attempt, 5))))
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.started else { return }
      self.reconnectWork.removeValue(forKey: peripheral.identifier)
      self.connectIfNeeded(peripheral, using: manager)
    }
    reconnectWork[peripheral.identifier] = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
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
    writeOrder[peripheral.identifier, default: []].append(.identity)
    peripheral.writeValue(identityData(), for: rx, type: .withResponse)
  }

  private func beginSend(peerId: String, packet: String, promise: Promise) {
    guard started else {
      promise.reject("ERR_STOPPED", "Bluetooth is not running")
      return
    }
    guard let payload = packet.data(using: .utf8) else {
      promise.reject("ERR_PACKET", "Message could not be encoded")
      return
    }
    guard hasLiveLink(peerId) else {
      promise.reject("ERR_NOT_CONNECTED", "Peer is not connected over Bluetooth.")
      return
    }
    sendToken += 1
    sendQueue.append(PendingSend(peerId: peerId, payload: payload, promise: promise, token: sendToken))
    pumpSend()
  }

  private func pumpSend() {
    guard !sending, !sendQueue.isEmpty else { return }
    if sendQueue[0].route == nil {
      var job = sendQueue[0]
      // Frames never exceed ATT_MTU-3 on either route. `maximumWriteValueLength(for:
      // .withResponse)` reports 512 because CoreBluetooth would split a larger value into
      // a prepared (long) write, which the Android GATT server does not reassemble; the
      // peer then never answers and the link dies at the ATT timeout.
      let frames: [Data]?
      if !job.writeFailed, let link = writeLink(for: job.peerId) {
        job.route = .write(link.peripheral.identifier)
        frames = makeFrames(payload: job.payload, maxPayload: link.peripheral.maximumWriteValueLength(for: .withoutResponse) - 3)
      } else if !job.notifyFailed, let central = notifyCentral(for: job.peerId) {
        job.route = .notify(central.identifier)
        frames = makeFrames(payload: job.payload, maxPayload: central.maximumUpdateValueLength - 3)
      } else {
        failCurrentSend("Peer is not connected over Bluetooth.")
        return
      }
      guard let frames else {
        failCurrentSend("Message is too large for Bluetooth")
        return
      }
      job.frames = frames
      job.index = 0
      sendQueue[0] = job
    }
    let job = sendQueue[0]
    guard job.index < job.frames.count, let route = job.route else {
      finishCurrentSend(success: true, message: nil)
      return
    }
    let frame = job.frames[job.index]
    switch route {
    case .write(let hardware):
      guard let link = clientLinks[hardware], link.peripheral.state == .connected, let rx = link.rx else {
        abandonRoute()
        return
      }
      sending = true
      inflightWrite = (hardware, job.token, job.index)
      armSendTimeout(token: job.token, index: job.index)
      writeOrder[hardware, default: []].append(.frame(token: job.token, index: job.index))
      link.peripheral.writeValue(frame, for: rx, type: .withResponse)
    case .notify(let centralId):
      guard let central = notifyCentral(for: job.peerId), central.identifier == centralId,
            let tx = txCharacteristic, let manager = peripheralManager else {
        abandonRoute()
        return
      }
      sending = true
      inflightWrite = nil
      if manager.updateValue(frame, for: tx, onSubscribedCentrals: [central]) {
        advanceFrame()
      } else {
        // Queue full: peripheralManagerIsReady resumes this frame; the timeout covers a
        // central that never drains it.
        armSendTimeout(token: job.token, index: job.index)
      }
    }
  }

  private func armSendTimeout(token: Int, index: Int) {
    sendTimeout?.cancel()
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.sending,
            let job = self.sendQueue.first,
            job.token == token, job.index == index else { return }
      self.log("warn", "[MSG] frame timed out")
      // A write that never completes blocks every later write on that link inside
      // CoreBluetooth until its own 30s ATT timeout; drop the link now so the reconnect
      // path brings back a usable one.
      if case .write(let hardware)? = job.route, let link = self.clientLinks[hardware] {
        self.cancelConnection(link.peripheral)
      }
      self.abandonRoute()
    }
    sendTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: timeout)
  }

  private func clearInflight() {
    sendTimeout?.cancel()
    sendTimeout = nil
    sending = false
    inflightWrite = nil
  }

  private func advanceFrame() {
    clearInflight()
    guard !sendQueue.isEmpty else { return }
    sendQueue[0].index += 1
    if sendQueue[0].index >= sendQueue[0].frames.count {
      finishCurrentSend(success: true, message: nil)
    } else {
      pumpSend()
    }
  }

  /// The current route stopped working (link lost, write error, or timeout). Mark it
  /// dead for this job and let pumpSend pick the other route or fail fast. The packet
  /// restarts from frame 0 on the new route: the receiver resets its assembler on seq 0,
  /// and the two routes may have different MTUs.
  private func abandonRoute() {
    clearInflight()
    guard !sendQueue.isEmpty, let route = sendQueue[0].route else { return }
    switch route {
    case .write: sendQueue[0].writeFailed = true
    case .notify: sendQueue[0].notifyFailed = true
    }
    sendQueue[0].route = nil
    if !sendQueue[0].writeFailed || !sendQueue[0].notifyFailed {
      log("warn", "[MSG] switching Bluetooth path")
    }
    pumpSend()
  }

  private func writeLinkLost(_ hardware: UUID) {
    guard let job = sendQueue.first, case .write(let inflight)? = job.route, inflight == hardware else { return }
    abandonRoute()
  }

  private func notifyLinkLost(_ centralId: UUID) {
    guard let job = sendQueue.first, case .notify(let inflight)? = job.route, inflight == centralId else { return }
    abandonRoute()
  }

  private func failCurrentSend(_ message: String) {
    finishCurrentSend(success: false, message: message)
  }

  private func finishCurrentSend(success: Bool, message: String?) {
    clearInflight()
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
    clearInflight()
    let jobs = sendQueue
    sendQueue.removeAll()
    for job in jobs {
      job.promise.reject("ERR_SEND", message)
    }
  }

  /// nil when the packet needs more than the 255 frames the one-byte sequence allows.
  private func makeFrames(payload: Data, maxPayload: Int) -> [Data]? {
    let size = max(1, maxPayload)
    let total = max(1, Int(ceil(Double(payload.count) / Double(size))))
    guard total <= 255 else { return nil }
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
    let now = Date().timeIntervalSince1970 * 1000
    var assembler = assemblers[peerId]
    let stale = assembler.map { now - $0.startedAt > 2_500 } ?? false
    if seq == 0 || assembler == nil || assembler?.total != total || stale {
      guard seq == 0 else { return }
      assembler = FrameAssembler(total: total, parts: [:], startedAt: now)
    }
    assembler!.parts[seq] = part
    assembler!.startedAt = now
    if assembler!.parts.count == total {
      assemblers.removeValue(forKey: peerId)
      var payload = Data()
      for index in 0..<total {
        guard let next = assembler!.parts[index] else { return }
        payload.append(next)
      }
      guard let packet = String(data: payload, encoding: .utf8) else {
        log("error", "[ERROR] invalid packet encoding")
        return
      }
      log("info", "[MSG] received \(payload.count) bytes")
      sendEvent("onPacketReceived", ["peerId": peerId, "packet": packet])
    } else {
      assemblers[peerId] = assembler!
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
        rssi: sanitizedRssi(previous?.rssi) ?? sanitizedRssi(peers[id]?.rssi),
        lastSeen: now,
        nored: true,
        confirmedIdentity: true,
        avatarIcon: avatarIcon ?? previous?.avatarIcon,
        avatarColor: avatarColor ?? previous?.avatarColor
      )
    } else {
      let existing = peers[id]
      let fallback = requestedReplacement.flatMap { peers[$0]?.rssi }
      peers[id] = PeerRecord(
        id: id,
        name: name,
        rssi: sanitizedRssi(existing?.rssi) ?? sanitizedRssi(fallback),
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

  private func sanitizedRssi(_ raw: Int?) -> Int? {
    guard let raw, raw != 127, raw >= -127, raw <= 20 else { return nil }
    return raw
  }

  private func signalBucket(_ rssi: Int?) -> Int {
    guard let rssi = sanitizedRssi(rssi) else { return 0 }
    if rssi >= -60 { return 3 }
    if rssi >= -75 { return 2 }
    return 1
  }

  private func pollRemoteRssi() {
    for link in clientLinks.values {
      link.peripheral.readRSSI()
    }
  }

  public func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
    guard error == nil else { return }
    applyRssi(hardwareId: peripheral.identifier.uuidString.lowercased(), raw: RSSI.intValue)
  }

  private func applyRssi(hardwareId: String, raw: Int) {
    guard let rssi = sanitizedRssi(raw) else { return }
    let peerId = hardwareIdToPeerId[hardwareId] ?? hardwareId
    guard var peer = peers[peerId] ?? peers[hardwareId] else { return }
    let previous = peer.rssi
    if previous == rssi { return }
    let bucketChanged = signalBucket(previous) != signalBucket(rssi)
    peer.rssi = rssi
    peers[peer.id] = peer
    if bucketChanged {
      lastEmitAt[peer.id] = Date().timeIntervalSince1970 * 1000
      sendEvent("onPeerDiscovered", peerMap(peer))
    }
  }

  private func peerMap(_ peer: PeerRecord, replacesId: String? = nil) -> [String: Any] {
    var map: [String: Any] = [
      "id": peer.id,
      "name": peer.name,
      "lastSeen": peer.lastSeen,
      "nored": peer.nored,
      "identityConfirmed": peer.confirmedIdentity,
      "connected": hasLiveLink(peer.id),
    ]
    if let rssi = sanitizedRssi(peer.rssi) {
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
