import { View, type ViewStyle } from 'react-native';

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

export function MicIcon({ size = 20, color, strokeWidth = 1.6 }: IconProps) {
  return (
    <View style={{ alignItems: 'center', height: size, width: size }}>
      <View
        style={{
          borderColor: color,
          borderRadius: size * 0.22,
          borderWidth: strokeWidth,
          height: size * 0.52,
          width: size * 0.32,
        }}
      />
      <View
        style={{
          borderBottomLeftRadius: size * 0.3,
          borderBottomRightRadius: size * 0.3,
          borderColor: color,
          borderLeftWidth: strokeWidth,
          borderRightWidth: strokeWidth,
          borderBottomWidth: strokeWidth,
          borderTopWidth: 0,
          height: size * 0.34,
          marginTop: -strokeWidth,
          width: size * 0.56,
        }}
      />
      <View style={{ backgroundColor: color, height: size * 0.16, marginTop: 2, width: strokeWidth }} />
      <View style={{ backgroundColor: color, borderRadius: 1, height: strokeWidth, marginTop: 1, width: size * 0.3 }} />
    </View>
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

export function GearIcon({ size = 20, color, strokeWidth = 1.6 }: IconProps) {
  return (
    <View style={{ alignItems: 'center', height: size, justifyContent: 'center', width: size }}>
      <View
        style={{
          borderColor: color,
          borderRadius: size * 0.32,
          borderWidth: strokeWidth,
          height: size * 0.64,
          width: size * 0.64,
        }}
      />
      {[0, 45, 90, 135].map((deg) => (
        <View
          key={deg}
          style={{
            backgroundColor: color,
            height: size,
            position: 'absolute',
            transform: [{ rotate: `${deg}deg` }],
            width: strokeWidth,
          }}
        />
      ))}
      <View style={{ backgroundColor: color, borderRadius: size * 0.16, height: size * 0.32, position: 'absolute', width: size * 0.32 }} />
      <View
        style={{
          backgroundColor: '#fff',
          borderRadius: size * 0.1,
          height: size * 0.2,
          position: 'absolute',
          width: size * 0.2,
        }}
      />
    </View>
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
