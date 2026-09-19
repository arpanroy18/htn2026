import CoreBluetooth
import ExpoModulesCore
import UIKit

private let serviceUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000001")
private let identityUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000002")
private let rxUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000003")
private let txUUID = CBUUID(string: "6E4F5245-442D-4D45-5348-000000000004")
private let deviceIdKey = "nored_ble_device_id"
private let displayNameKey = "nored_ble_display_name"

private struct PeerRecord {
  let id: String
  let name: String
  let centralId: UUID
  var lastSeen: Double
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
}

public final class NoredBluetoothModule: Module {
  private var peripheralManager: CBPeripheralManager?
  private var peripheralDelegate: NoredPeripheralDelegate?
  private var identityCharacteristic: CBMutableCharacteristic?
  private var rxCharacteristic: CBMutableCharacteristic?
  private var txCharacteristic: CBMutableCharacteristic?
  private var peers: [String: PeerRecord] = [:]
  private var centralToPeer: [UUID: String] = [:]
  private var started = false

  public func definition() -> ModuleDefinition {
    Name("NoredBluetooth")

    Events("onPeerDiscovered", "onPeerLost", "onStateChanged", "onLog")

    Function("isSupported") {
      #if targetEnvironment(simulator)
      return false
      #else
      return true
      #endif
    }

    Function("requiredPermissions") { [] as [String] }
    Function("getIdentity") { self.identityMap() }
    Function("getPeers") { self.peers.values.sorted { $0.lastSeen > $1.lastSeen }.map(self.peerMap) }

    AsyncFunction("setDisplayName") { (rawName: String) -> [String: Any] in
      let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !name.isEmpty, name.count <= 40 else {
        throw Exception(name: "ERR_INVALID_NAME", description: "Display name must be 1 to 40 characters")
      }
      UserDefaults.standard.set(name, forKey: displayNameKey)
      return self.identityMap()
    }

    AsyncFunction("start") {
      self.startAdvertising()
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stopAdvertising()
    }.runOnQueue(.main)

    OnAppEntersForeground {
      if self.started, self.peripheralManager?.state == .poweredOn {
        self.beginAdvertisingIfReady()
      }
    }

    OnDestroy {
      self.stopAdvertising()
    }
  }

  private func identityMap() -> [String: Any] {
    let defaults = UserDefaults.standard
    var id = defaults.string(forKey: deviceIdKey)
    if id == nil {
      id = UUID().uuidString.lowercased()
      defaults.set(id, forKey: deviceIdKey)
    }
    var name = defaults.string(forKey: displayNameKey)
    if name == nil {
      name = String(UIDevice.current.name.prefix(40))
      defaults.set(name, forKey: displayNameKey)
    }
    return ["id": id!, "name": name!]
  }

  private func identityData() -> Data {
    let identity = identityMap()
    return (try? JSONSerialization.data(withJSONObject: [
      "v": 1,
      "id": identity["id"]!,
      "name": identity["name"]!
    ])) ?? Data()
  }

  private func startAdvertising() {
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
    if peripheralManager == nil {
      let delegate = NoredPeripheralDelegate(owner: self)
      peripheralDelegate = delegate
      peripheralManager = CBPeripheralManager(
        delegate: delegate,
        queue: .main,
        options: [CBPeripheralManagerOptionShowPowerAlertKey: true]
      )
    } else if peripheralManager?.state == .poweredOn {
      configureServiceIfNeeded()
      beginAdvertisingIfReady()
    }
    #endif
  }

  private func stopAdvertising() {
    started = false
    peripheralManager?.stopAdvertising()
    peripheralManager?.removeAllServices()
    identityCharacteristic = nil
    rxCharacteristic = nil
    txCharacteristic = nil
    peers.keys.forEach(emitPeerLost)
    peers.removeAll()
    centralToPeer.removeAll()
    emitState("stopped")
  }

  private func configureServiceIfNeeded() {
    guard started, identityCharacteristic == nil else { return }
    let identity = CBMutableCharacteristic(
      type: identityUUID,
      properties: [.read],
      value: nil,
      permissions: [.readable]
    )
    let rx = CBMutableCharacteristic(
      type: rxUUID,
      properties: [.write],
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
          identityCharacteristic != nil,
          peripheralManager?.isAdvertising == false else { return }
    peripheralManager?.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID]])
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
      emitState("unknown")
    }
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    didAdd service: CBService,
    error: Error?
  ) {
    if let error {
      log("error", "[ERROR] GATT service setup failed: \(error.localizedDescription)")
      emitState("unknown")
      return
    }
    beginAdvertisingIfReady()
  }

  public func peripheralManagerDidStartAdvertising(
    _ peripheral: CBPeripheralManager,
    error: Error?
  ) {
    if let error {
      log("error", "[ERROR] advertiser failed: \(error.localizedDescription)")
      emitState("unknown")
      return
    }
    log("info", "[BLE] advertiser started")
    emitState("running")
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
      do {
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let id = value?["id"] as? String,
              UUID(uuidString: id) != nil,
              let rawName = value?["name"] as? String else {
          peripheral.respond(to: request, withResult: .unlikelyError)
          continue
        }
        let record = PeerRecord(
          id: id,
          name: String(rawName.prefix(40)),
          centralId: request.central.identifier,
          lastSeen: Date().timeIntervalSince1970 * 1000
        )
        peers[id] = record
        centralToPeer[request.central.identifier] = id
        sendEvent("onPeerDiscovered", peerMap(record))
        log("info", "[DISCOVERY] peer discovered \(String(id.prefix(8)))")
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
  }

  public func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    if let peerId = centralToPeer.removeValue(forKey: central.identifier) {
      peers.removeValue(forKey: peerId)
      emitPeerLost(peerId)
      log("info", "[CONNECTION] disconnected \(String(peerId.prefix(8)))")
    }
  }

  private func peerMap(_ peer: PeerRecord) -> [String: Any] {
    [
      "id": peer.id,
      "name": peer.name,
      "lastSeen": peer.lastSeen
    ]
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
