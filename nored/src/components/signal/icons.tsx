import { SymbolView } from 'expo-symbols';
import { View, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

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

export function AlertsIcon({ size = 24, color, strokeWidth = 1.6 }: IconProps) {
  const h = size * 0.86;
  return (
    <View style={{ alignItems: 'center', height: size, justifyContent: 'flex-start', width: size }}>
      <View
        style={{
          borderBottomColor: color,
          borderBottomWidth: h,
          borderLeftColor: 'transparent',
          borderLeftWidth: size / 2,
          borderRightColor: 'transparent',
          borderRightWidth: size / 2,
          height: 0,
          width: 0,
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          height: h * 0.34,
          position: 'absolute',
          top: h * 0.28,
          width: strokeWidth + 0.4,
        }}
      />
      <View
        style={{
          backgroundColor: color,
          borderRadius: 1,
          bottom: h * 0.16,
          height: strokeWidth + 0.6,
          position: 'absolute',
          width: strokeWidth + 0.6,
        }}
      />
    </View>
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
