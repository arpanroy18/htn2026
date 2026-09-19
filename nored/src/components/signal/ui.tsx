import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { avatarFromSeed, resolveAvatar } from '@/avatar/profile';
import { AnimalFace } from '@/components/signal/animalFaces';
import { ChatsIcon } from '@/components/signal/icons';
import { signal } from '@/theme/signal';

export function OutlinedButton({
  label,
  onPress,
  disabled,
  style,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.outlined,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}>
      <Text style={styles.outlinedLabel}>{label}</Text>
    </Pressable>
  );
}

export function MistButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.mist, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={styles.mistLabel}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  children,
  onPress,
  disabled,
  tone = 'outline',
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  tone?: 'outline' | 'ghost' | 'filled';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        tone === 'outline' && styles.iconOutline,
        tone === 'filled' && styles.iconFilled,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}>
      {children}
    </Pressable>
  );
}

export function TextLink({
  label,
  onPress,
  style,
}: {
  label: string;
  onPress?: () => void;
  style?: TextStyle;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      <Text style={[styles.link, style]}>{label}</Text>
    </Pressable>
  );
}

export function Hairline() {
  return <View style={styles.hairline} />;
}

export function Chip({
  label,
  tone = 'fog',
}: {
  label: string;
  tone?: 'fog' | 'sky' | 'mist' | 'blue' | 'yellow' | 'orange' | 'red';
}) {
  const lightText = tone === 'blue' || tone === 'orange' || tone === 'red';
  return (
    <View
      style={[
        styles.chip,
        tone === 'sky' && { backgroundColor: signal.sky },
        tone === 'mist' && { backgroundColor: signal.mist },
        tone === 'blue' && { backgroundColor: signal.blue },
        tone === 'yellow' && { backgroundColor: signal.yellow },
        tone === 'orange' && { backgroundColor: signal.orange },
        tone === 'red' && { backgroundColor: signal.red },
      ]}>
      <Text style={[styles.chipText, lightText && { color: signal.white }]}>{label}</Text>
    </View>
  );
}

export function UnreadDot({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return <View style={styles.dot} />;
}

export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

export type AvatarStackMember = {
  id: string;
  name: string;
  peerId?: string;
  icon?: string;
  color?: number;
};

function StackDisc({
  children,
  index,
  overlap,
  outer,
}: {
  children: ReactNode;
  index: number;
  overlap: number;
  outer: number;
}) {
  return (
    <View
      style={[
        styles.avatarStackItem,
        {
          borderRadius: outer / 2,
          height: outer,
          marginLeft: index === 0 ? 0 : -overlap,
          width: outer,
          zIndex: index + 1,
        },
      ]}>
      {children}
    </View>
  );
}

export function AvatarStack({
  members,
  size = 36,
  max = 5,
}: {
  members: AvatarStackMember[];
  size?: number;
  max?: number;
}) {
  if (members.length === 0) return null;
  const ring = 3;
  const outer = size + ring * 2;
  const overlap = Math.round(size * 0.42);
  const visible = members.slice(0, max);
  const overflow = members.length - visible.length;

  return (
    <View style={styles.avatarStack}>
      {visible.map((member, index) => (
        <StackDisc index={index} key={member.id} outer={outer} overlap={overlap}>
          <Avatar
            color={member.color}
            icon={member.icon}
            name={member.name}
            peerId={member.peerId ?? member.id}
            size={size}
          />
        </StackDisc>
      ))}
      {overflow > 0 ? (
        <StackDisc index={visible.length} outer={outer} overlap={overlap}>
          <View style={[styles.avatarStackOverflow, { borderRadius: size / 2, height: size, width: size }]}>
            <Text style={[styles.avatarStackOverflowText, { fontSize: size * 0.32 }]}>+{overflow}</Text>
          </View>
        </StackDisc>
      ) : null}
    </View>
  );
}

export function Avatar({
  name,
  peerId,
  icon,
  color,
  size = 44,
  kind = 'dm',
}: {
  name: string;
  peerId?: string;
  icon?: string;
  color?: number;
  size?: number;
  kind?: 'dm' | 'group';
}) {
  const seed = peerId ?? name;
  const profile = kind === 'group' ? avatarFromSeed(name) : resolveAvatar(seed, icon, color);
  const iconSize = size * (kind === 'group' ? 0.46 : 0.64);
  return (
    <View
      style={[
        styles.avatar,
        {
          backgroundColor: profile.tone.bg,
          borderRadius: kind === 'group' ? size * 0.32 : size / 2,
          height: size,
          width: size,
        },
      ]}>
      {kind === 'group' ? (
        <ChatsIcon color={signal.ink} size={iconSize} />
      ) : (
        <AnimalFace animal={profile.icon} size={iconSize} />
      )}
    </View>
  );
}

export function RowPress({
  children,
  onPress,
  onLongPress,
  disabled,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
} & Pick<PressableProps, 'onPress'>) {
  return (
    <Pressable
      disabled={disabled}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [style, pressed && styles.rowPressed, disabled && styles.disabled]}>
      {children}
    </Pressable>
  );
}

export function GroupedList({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.group, style]}>
      {items.map((child, index) => (
        <Fragment key={index}>
          {child}
          {index < items.length - 1 ? <Hairline /> : null}
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  outlined: {
    alignItems: 'center',
    backgroundColor: signal.white,
    borderColor: signal.blue,
    borderRadius: 8,
    borderWidth: 1.5,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  outlinedLabel: {
    color: signal.blue,
    fontSize: 16,
    fontWeight: '600',
  },
  mist: {
    alignItems: 'center',
    backgroundColor: signal.mist,
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  mistLabel: {
    color: signal.white,
    fontSize: 16,
    fontWeight: '600',
  },
  iconButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  iconOutline: {
    backgroundColor: signal.white,
    borderColor: signal.blue,
    borderWidth: 1.5,
  },
  iconFilled: {
    backgroundColor: signal.blue,
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.98 }],
  },
  rowPressed: {
    backgroundColor: signal.paper,
  },
  disabled: {
    opacity: 0.4,
  },
  link: {
    color: signal.deep,
    fontSize: 16,
    fontWeight: '400',
  },
  hairline: {
    backgroundColor: signal.fog,
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  chip: {
    backgroundColor: signal.fog,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: {
    color: signal.ink,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  dot: {
    backgroundColor: signal.deep,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  badge: {
    alignItems: 'center',
    backgroundColor: signal.deep,
    borderRadius: 10,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 5,
    height: 20,
  },
  badgeText: {
    color: signal.white,
    fontSize: 12,
    fontWeight: '700',
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarStack: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  avatarStackItem: {
    alignItems: 'center',
    backgroundColor: signal.paper,
    justifyContent: 'center',
  },
  avatarStackOverflow: {
    alignItems: 'center',
    backgroundColor: signal.fog,
    justifyContent: 'center',
  },
  avatarStackOverflowText: {
    color: signal.slate,
    fontWeight: '700',
  },
  group: {
    backgroundColor: signal.white,
    borderColor: signal.fog,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
