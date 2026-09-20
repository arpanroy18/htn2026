import { SymbolView } from 'expo-symbols';
import { View, type ViewStyle } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

type IconProps = {
  size?: number;
  color: string;
  strokeWidth?: number;
};

export function NearbyIcon({ size = 24, color, strokeWidth = 1.6 }: IconProps) {
  const outer = size;
  const mid = size * 0.62;
  const dot = size * 0.2;
  return (
    <View style={{ alignItems: 'center', height: outer, justifyContent: 'center', width: outer }}>
      <View
        style={{
          borderColor: color,
          borderRadius: outer / 2,
          borderWidth: strokeWidth,
          height: outer,
          opacity: 0.35,
          position: 'absolute',
          width: outer,
        }}
      />
      <View
        style={{
          borderColor: color,
          borderRadius: mid / 2,
          borderWidth: strokeWidth,
          height: mid,
          position: 'absolute',
          width: mid,
        }}
      />
      <View style={{ backgroundColor: color, borderRadius: dot / 2, height: dot, width: dot }} />
    </View>
  );
}

export function ChatsIcon({ size = 24, color, strokeWidth = 1.6 }: IconProps) {
  const w = size;
  const h = size * 0.78;
  return (
    <View style={{ height: size, width: size }}>
      <View
        style={{
          borderColor: color,
          borderRadius: h * 0.36,
          borderWidth: strokeWidth,
          height: h,
          width: w,
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: size * 0.16,
          left: w * 0.22,
          position: 'absolute',
          top: h - strokeWidth,
          transform: [{ rotate: '45deg' }],
          width: size * 0.16,
        }}
      />
    </View>
  );
}

export function AlertsIcon({ size = 24, color }: IconProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d="M12 6.5C12.5523 6.5 13 6.94772 13 7.5L13 13.5C13 14.0523 12.5523 14.5 12 14.5C11.4477 14.5 11 14.0523 11 13.5L11 7.5C11 6.94772 11.4477 6.5 12 6.5Z"
        fill={color}
      />
      <Path
        d="M12 18.5C12.8284 18.5 13.5 17.8284 13.5 17C13.5 16.1716 12.8284 15.5 12 15.5C11.1716 15.5 10.5 16.1716 10.5 17C10.5 17.8284 11.1716 18.5 12 18.5Z"
        fill={color}
      />
      <Path
        clipRule="evenodd"
        d="M9.82664 2.22902C10.7938 0.590326 13.2063 0.590325 14.1735 2.22902L23.6599 18.3024C24.6578 19.9933 23.3638 22 21.4865 22H2.51362C0.63634 22 -0.657696 19.9933 0.340215 18.3024L9.82664 2.22902ZM12.4511 3.24557C12.2578 2.91814 11.7423 2.91814 11.549 3.24557L2.06261 19.319C1.90904 19.5792 2.07002 20 2.51362 20H21.4865C21.9301 20 22.0911 19.5792 21.9375 19.319L12.4511 3.24557Z"
        fill={color}
        fillRule="evenodd"
      />
    </Svg>
  );
}

export function GamesIcon({ size = 24, color, strokeWidth = 1.6 }: IconProps) {
  const cell = size * 0.42;
  const gap = size * 0.16;
  const cellStyle: ViewStyle = {
    borderColor: color,
    borderRadius: 3,
    borderWidth: strokeWidth,
    height: cell,
    width: cell,
  };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, height: size, width: size }}>
      <View style={cellStyle} />
      <View style={cellStyle} />
      <View style={cellStyle} />
      <View style={cellStyle} />
    </View>
  );
}

export function ChessIcon({ size = 24, color }: IconProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <G transform="matrix(-1, 0, 0, 1, 24, 0)">
        <Path
          clipRule="evenodd"
          d="M10.5014 1.15359C10.8116 0.975177 11.1935 0.97613 11.5029 1.15609C12.3449 1.64601 13.1238 2.05985 13.8587 2.4503L13.8587 2.45031C14.036 2.54449 14.2107 2.63732 14.3831 2.72953C15.2573 3.19699 16.0823 3.65354 16.811 4.16777C18.3248 5.23608 19.4192 6.5535 19.9701 8.7574C20.5121 10.9255 20.2212 12.8599 19.8424 14.661C19.7713 14.999 19.6979 15.33 19.6254 15.6567L19.6254 15.657L19.6253 15.6572C19.3752 16.7852 19.1364 17.8621 19.0422 19L19.4114 19L19.8418 19L19.9591 19H19.9896H19.9974H19.9994H19.9998H20H20C20.4304 19 20.8126 19.2754 20.9487 19.6838L21.7207 22H22C22.5523 22 23 22.4477 23 23C23 23.5523 22.5523 24 22 24H21H4.99999H3.99999C3.4477 24 2.99999 23.5523 2.99999 23C2.99999 22.4477 3.4477 22 3.99999 22H4.27923L5.0513 19.6838C5.18742 19.2754 5.56956 19 5.99999 19H7.32295L8.76926 15.3842L3.5401 16.7603C2.62461 17.0013 1.66561 16.5673 1.24226 15.7206L0.445745 14.1276C0.0446075 13.3253 0.224632 12.3499 0.899071 11.7473C1.70728 11.0252 3.23043 9.67416 4.3593 8.73219C4.843 8.32858 5.20051 7.8615 5.53425 7.34475C5.66811 7.13749 5.79158 6.93296 5.92146 6.71778C5.95694 6.65901 5.9929 6.59944 6.02967 6.53881C6.19574 6.26503 6.37548 5.97487 6.57499 5.69604C6.97917 5.13114 7.49272 4.57147 8.24793 4.18005C8.75596 3.91675 9.33341 3.75004 9.99999 3.68226V2.02045C9.99999 1.66259 10.1912 1.33201 10.5014 1.15359ZM10.9804 14.8024C11.0177 14.9867 11.0035 15.1837 10.9285 15.3714L9.47702 19L11.6541 19L17.0372 19C17.1375 17.6202 17.424 16.3351 17.6873 15.1537C17.7561 14.8451 17.8233 14.5436 17.8852 14.2493C18.2489 12.5205 18.458 10.955 18.0298 9.24247C17.6107 7.56581 16.836 6.63326 15.6578 5.80185C15.0405 5.36622 14.3138 4.96048 13.44 4.49317C13.2759 4.40542 13.1069 4.31563 12.9332 4.2234L12.9332 4.22336L12.933 4.22327L12.9325 4.22299C12.6347 4.06478 12.3233 3.89937 12 3.72468V4.6531C12 4.92495 11.8893 5.18509 11.6934 5.3736C11.4976 5.56212 11.2334 5.66277 10.9617 5.65237C10.0884 5.61894 9.54299 5.7615 9.16824 5.95573C8.79357 6.14991 8.50124 6.44093 8.20152 6.85983C8.04907 7.07288 7.90234 7.3079 7.73968 7.57607L7.64174 7.73808L7.64172 7.73812C7.50998 7.95641 7.36635 8.19443 7.21432 8.42982C6.82599 9.03109 6.34133 9.68314 5.64067 10.2678C4.54252 11.1841 3.04532 12.5118 2.23561 13.2352L3.03111 14.8262L11.7455 12.5329C12.2796 12.3924 12.8265 12.7114 12.9671 13.2455C13.1076 13.7796 12.7886 14.3265 12.2545 14.4671L10.9804 14.8024ZM7 21H9L9.05777 21L11.6541 21L18 21L19.2792 21L19.6126 22H6.38741L6.72075 21L7 21ZM9.5 11C10.3284 11 11 10.3284 11 9.5C11 8.67157 10.3284 8 9.5 8C8.67157 8 8 8.67157 8 9.5C8 10.3284 8.67157 11 9.5 11Z"
          fill={color}
          fillRule="evenodd"
        />
      </G>
    </Svg>
  );
}

export function PongIcon({ size = 24, color }: IconProps) {
  return (
    <Svg fill={color} height={size} viewBox="0 0 512 512" width={size}>
      <G transform="matrix(-1, 0, 0, 1, 512, 0)">
        <Path d="M502.08,430.441l-80.346-80.338c-3.204-3.228-5.027-6.135-6.232-9.147c-1.043-2.642-1.614-5.436-1.766-8.761 c-0.128-2.883,0.096-6.152,0.666-9.797c0.988-6.401,3.076-13.902,5.718-22.277c3.95-12.592,9.122-27.128,12.92-43.542 c3.783-16.407,6.168-34.789,4.329-54.93c-0.996-10.906-4.048-21.409-8.102-31.319c-6.112-14.857-14.536-28.421-22.735-39.72 c-4.095-5.645-8.151-10.712-11.861-15.058c-3.71-4.344-7.066-7.958-9.853-10.736c-0.892-0.892-2.281-2.386-3.975-4.256 c-2.546-2.811-5.822-6.513-9.718-10.761c-3.91-4.24-8.448-9.066-13.587-14.206c-11.821-11.821-26.846-25.361-44.971-37.832 c-18.126-12.456-39.395-23.868-63.662-31.256c-20.952-6.384-41.494-7.677-60.676-5.573c-28.814,3.156-54.548,13.78-75.7,26.059 C91.363,39.311,74.76,53.3,64.027,64.02c-7.16,7.163-15.74,16.921-24.34,28.911c-12.874,17.98-25.811,40.955-33.324,67.561 c-3.742,13.29-6.115,27.504-6.344,42.362c-0.225,14.848,1.71,30.339,6.493,46.039c7.388,24.276,18.796,45.542,31.256,63.674 c12.467,18.118,26.007,33.151,37.828,44.972c6.854,6.85,13.134,12.632,18.262,17.258c2.558,2.322,4.826,4.345,6.701,6.048 c1.875,1.686,3.361,3.075,4.26,3.975c3.706,3.702,8.902,8.448,15.318,13.66c9.621,7.806,21.928,16.624,35.809,23.996 c6.946,3.686,14.282,7.019,21.928,9.629c7.648,2.618,15.603,4.521,23.778,5.268c20.048,1.823,38.342-0.522,54.696-4.28 c12.267-2.819,23.474-6.417,33.624-9.709c7.609-2.465,14.62-4.746,20.952-6.456c4.746-1.286,9.107-2.224,13.014-2.755 c2.927-0.386,5.593-0.538,8.002-0.45c3.63,0.145,6.633,0.763,9.48,1.96c2.843,1.213,5.622,3.003,8.682,6.055L440.366,512 l71.632-71.633L502.08,430.441z M185.884,405.169c-1.631-0.57-3.261-1.196-4.899-1.871c-11.962-4.891-23.896-12.207-33.874-19.466 c-4.991-3.63-9.512-7.244-13.327-10.504c-3.818-3.26-6.958-6.183-9.126-8.352c-1.538-1.542-3.26-3.124-5.252-4.931 c-2.988-2.706-6.569-5.879-10.625-9.605c-4.047-3.718-8.568-7.966-13.346-12.744c-10.982-10.977-23.353-24.758-34.548-41.028 C49.7,280.39,39.719,261.654,33.354,240.726c-5.192-17.081-6.24-33.616-4.521-49.46c2.574-23.746,11.568-45.975,22.426-64.638 c5.412-9.316,11.275-17.731,16.937-24.959c5.661-7.212,11.126-13.258,15.675-17.804c6.063-6.063,14.768-13.749,25.417-21.378 c15.965-11.459,36.322-22.782,58.824-29.11c11.255-3.173,23.036-5.116,35.17-5.293c12.142-0.184,24.63,1.365,37.442,5.268 c20.928,6.369,39.668,16.35,55.942,27.538c16.274,11.186,30.05,23.562,41.032,34.548c6.372,6.368,11.801,12.262,16.29,17.234 c2.248,2.481,4.256,4.738,6.063,6.729c1.807,1.992,3.389,3.718,4.923,5.252c2.907,2.907,7.115,7.492,11.725,13.17 c6.914,8.513,14.768,19.538,21,31.272c2.931,5.525,5.476,11.194,7.468,16.792L185.884,405.169z M440.373,472.312l-70.428-70.428 c-5.598-5.606-11.926-9.829-18.639-12.472c-5.871-2.337-11.938-3.453-17.873-3.71c-5.2-0.225-10.319,0.185-15.37,0.972 c-8.838,1.38-17.519,3.903-26.372,6.681c-13.258,4.176-26.935,9.01-41.414,12.335c-9.432,2.176-19.177,3.71-29.356,4.119 l188.896-188.888c-0.401,10.095-1.919,19.772-4.071,29.144c-2.482,10.8-5.79,21.177-9.051,31.247 c-2.441,7.556-4.875,14.952-6.866,22.301c-1.478,5.525-2.723,11.026-3.469,16.623c-0.554,4.184-0.836,8.416-0.674,12.72 c0.224,6.425,1.461,13.026,4.144,19.362c2.658,6.329,6.738,12.319,12.062,17.619l70.428,70.429L440.373,472.312z" />
      </G>
    </Svg>
  );
}

export function TelephoneIcon({ size = 24, color }: IconProps) {
  return (
    <Svg fill={color} height={size} viewBox="0 0 16 16" width={size}>
      <Path
        d="M1.885.511a1.745 1.745 0 0 1 2.61.163L6.29 2.98c.329.423.445.974.315 1.494l-.547 2.19a.678.678 0 0 0 .178.643l2.457 2.457a.678.678 0 0 0 .644.178l2.189-.547a1.745 1.745 0 0 1 1.494.315l2.306 1.794c.829.645.905 1.87.163 2.611l-1.034 1.034c-.74.74-1.846 1.065-2.877.702a18.634 18.634 0 0 1-7.01-4.42 18.634 18.634 0 0 1-4.42-7.009c-.362-1.03-.037-2.137.703-2.877L1.885.511z"
        fillRule="evenodd"
      />
    </Svg>
  );
}

export function MicIcon({ size = 20, color }: IconProps) {
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Path
        d="M5 3C5 1.34315 6.34315 0 8 0C9.65685 0 11 1.34315 11 3V7C11 8.65685 9.65685 10 8 10C6.34315 10 5 8.65685 5 7V3Z"
        fill={color}
      />
      <Path
        d="M9 13.9291V16H7V13.9291C3.60771 13.4439 1 10.5265 1 7V6H3V7C3 9.76142 5.23858 12 8 12C10.7614 12 13 9.76142 13 7V6H15V7C15 10.5265 12.3923 13.4439 9 13.9291Z"
        fill={color}
      />
    </Svg>
  );
}

export function ImageIcon({ size = 20, color, strokeWidth = 1.6 }: IconProps) {
  return (
    <View
      style={{
        borderColor: color,
        borderRadius: 5,
        borderWidth: strokeWidth,
        height: size * 0.74,
        overflow: 'hidden',
        width: size,
      }}>
      <View
        style={{
          backgroundColor: color,
          borderRadius: size * 0.06,
          height: size * 0.12,
          left: size * 0.13,
          position: 'absolute',
          top: size * 0.1,
          width: size * 0.12,
        }}
      />
      <View
        style={{
          borderBottomColor: color,
          borderBottomWidth: size * 0.26,
          borderLeftColor: 'transparent',
          borderLeftWidth: size * 0.2,
          borderRightColor: 'transparent',
          borderRightWidth: size * 0.2,
          bottom: 0,
          height: 0,
          left: size * 0.06,
          position: 'absolute',
          width: 0,
        }}
      />
      <View
        style={{
          borderBottomColor: color,
          borderBottomWidth: size * 0.36,
          borderLeftColor: 'transparent',
          borderLeftWidth: size * 0.14,
          borderRightColor: 'transparent',
          borderRightWidth: size * 0.14,
          bottom: 0,
          height: 0,
          position: 'absolute',
          right: size * 0.04,
          width: 0,
        }}
      />
    </View>
  );
}

export function SendIcon({ size = 18, color, strokeWidth = 1.8 }: IconProps) {
  return (
    <View style={{ alignItems: 'center', height: size, justifyContent: 'flex-end', width: size }}>
      <View
        style={{
          borderBottomColor: color,
          borderBottomWidth: size * 0.62,
          borderLeftColor: 'transparent',
          borderLeftWidth: size * 0.34,
          borderRightColor: 'transparent',
          borderRightWidth: size * 0.34,
          height: 0,
          width: 0,
        }}
      />
      <View style={{ backgroundColor: color, height: strokeWidth, marginTop: -strokeWidth / 2, width: size * 0.4 }} />
    </View>
  );
}

export function PlusIcon({ size = 18, color, strokeWidth = 1.8 }: IconProps) {
  return (
    <View style={{ alignItems: 'center', height: size, justifyContent: 'center', width: size }}>
      <View style={{ backgroundColor: color, height: strokeWidth, position: 'absolute', width: size * 0.66 }} />
      <View style={{ backgroundColor: color, height: size * 0.66, position: 'absolute', width: strokeWidth }} />
    </View>
  );
}

export function ChevronIcon({ size = 14, color, strokeWidth = 1.6 }: IconProps) {
  return (
    <View style={{ height: size, transform: [{ rotate: '45deg' }], width: size }}>
      <View
        style={{
          borderColor: color,
          borderBottomWidth: strokeWidth,
          borderRightWidth: strokeWidth,
          height: size * 0.5,
          width: size * 0.5,
        }}
      />
    </View>
  );
}

export function GearIcon({ size = 20, color }: IconProps) {
  return (
    <SymbolView
      name={{ android: 'settings', ios: 'gearshape', web: 'settings' }}
      size={size}
      tintColor={color}
      weight="medium"
    />
  );
}

export function RefreshIcon({ size = 20, color }: IconProps) {
  return (
    <SymbolView
      name={{ android: 'refresh', ios: 'arrow.clockwise', web: 'refresh' }}
      size={size}
      tintColor={color}
      weight="medium"
    />
  );
}

export function SignalBars({ level, size = 16, color, mutedColor }: { level: 0 | 1 | 2 | 3; size?: number; color: string; mutedColor: string }) {
  const heights = [size * 0.35, size * 0.6, size * 0.85];
  return (
    <View style={{ alignItems: 'flex-end', flexDirection: 'row', gap: 2, height: size }}>
      {heights.map((h, index) => (
        <View
          key={index}
          style={{
            backgroundColor: index < level ? color : mutedColor,
            borderRadius: 1,
            height: h,
            width: size * 0.2,
          }}
        />
      ))}
    </View>
  );
}
