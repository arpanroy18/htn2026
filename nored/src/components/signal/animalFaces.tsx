import type React from 'react';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import type { AnimalFaceId } from '@/avatar/profile';

const STROKE = '#181818';
const S = 3.2;

type FaceProps = { size: number };

function DogFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Rect fill="none" height={42} rx={16} stroke={STROKE} strokeWidth={S} width={44} x={10} y={14} />
      <Path
        d="M14 22 Q4 22 6 36 Q8 44 16 40 Z"
        fill="none"
        stroke={STROKE}
        strokeLinejoin="round"
        strokeWidth={S}
      />
      <Path
        d="M50 22 Q60 22 58 36 Q56 44 48 40 Z"
        fill="none"
        stroke={STROKE}
        strokeLinejoin="round"
        strokeWidth={S}
      />
      <Circle cx={24} cy={34} fill={STROKE} r={2.6} />
      <Circle cx={40} cy={34} fill={STROKE} r={2.6} />
      <Ellipse cx={32} cy={43} fill={STROKE} rx={4.4} ry={3.2} />
      <Path
        d="M32 46 L32 50 M32 50 Q28 53 25 51 M32 50 Q36 53 39 51"
        fill="none"
        stroke={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={S * 0.85}
      />
    </Svg>
  );
}

function CatFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Path d="M14 26 L8 8 L24 18 Z" fill="none" stroke={STROKE} strokeLinejoin="round" strokeWidth={S} />
      <Path d="M50 26 L56 8 L40 18 Z" fill="none" stroke={STROKE} strokeLinejoin="round" strokeWidth={S} />
      <Rect fill="none" height={38} rx={18} stroke={STROKE} strokeWidth={S} width={44} x={10} y={18} />
      <Circle cx={24} cy={35} fill={STROKE} r={2.6} />
      <Circle cx={40} cy={35} fill={STROKE} r={2.6} />
      <Path d="M32 39 L28 44 L36 44 Z" fill={STROKE} />
      <Path
        d="M32 44 Q32 47 27 47 M32 44 Q32 47 37 47"
        fill="none"
        stroke={STROKE}
        strokeLinecap="round"
        strokeWidth={S * 0.85}
      />
      <Path
        d="M6 38 L20 40 M6 46 L20 42 M58 38 L44 40 M58 46 L44 42"
        fill="none"
        stroke={STROKE}
        strokeLinecap="round"
        strokeWidth={S * 0.7}
      />
    </Svg>
  );
}

function LionFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Path
        d="M32 6 L38 16 L48 10 L48 22 L58 24 L50 32 L58 40 L48 42 L48 54 L38 48 L32 58 L26 48 L16 54 L16 42 L6 40 L14 32 L6 24 L16 22 L16 10 L26 16 Z"
        fill="none"
        stroke={STROKE}
        strokeLinejoin="round"
        strokeWidth={S * 0.85}
      />
      <Rect fill="none" height={26} rx={13} stroke={STROKE} strokeWidth={S} width={28} x={18} y={20} />
      <Circle cx={26} cy={31} fill={STROKE} r={2.4} />
      <Circle cx={38} cy={31} fill={STROKE} r={2.4} />
      <Ellipse cx={32} cy={38} fill={STROKE} rx={3.6} ry={2.6} />
    </Svg>
  );
}

function MonkeyFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Circle cx={12} cy={33} fill="none" r={9} stroke={STROKE} strokeWidth={S} />
      <Circle cx={52} cy={33} fill="none" r={9} stroke={STROKE} strokeWidth={S} />
      <Circle cx={32} cy={32} fill="none" r={24} stroke={STROKE} strokeWidth={S} />
      <Path
        d="M20 30 Q20 44 32 46 Q44 44 44 30 Q44 24 32 24 Q20 24 20 30 Z"
        fill="none"
        stroke={STROKE}
        strokeLinejoin="round"
        strokeWidth={S * 0.8}
      />
      <Circle cx={26} cy={31} fill={STROKE} r={2.5} />
      <Circle cx={38} cy={31} fill={STROKE} r={2.5} />
      <Circle cx={29} cy={38} fill={STROKE} r={1.3} />
      <Circle cx={35} cy={38} fill={STROKE} r={1.3} />
      <Path
        d="M27 41 Q32 44 37 41"
        fill="none"
        stroke={STROKE}
        strokeLinecap="round"
        strokeWidth={S * 0.75}
      />
    </Svg>
  );
}

function PandaFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Circle cx={15} cy={16} fill={STROKE} r={9} />
      <Circle cx={49} cy={16} fill={STROKE} r={9} />
      <Circle cx={32} cy={34} fill="none" r={26} stroke={STROKE} strokeWidth={S} />
      <Ellipse cx={22} cy={31} fill={STROKE} rx={7} ry={9} />
      <Ellipse cx={42} cy={31} fill={STROKE} rx={7} ry={9} />
      <Circle cx={22} cy={33} fill="#fff" r={2.4} />
      <Circle cx={42} cy={33} fill="#fff" r={2.4} />
      <Path d="M32 42 L28 47 L36 47 Z" fill={STROKE} />
    </Svg>
  );
}

function KoalaFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Circle cx={11} cy={20} fill="none" r={10} stroke={STROKE} strokeWidth={S} />
      <Circle cx={53} cy={20} fill="none" r={10} stroke={STROKE} strokeWidth={S} />
      <Circle cx={32} cy={36} fill="none" r={22} stroke={STROKE} strokeWidth={S} />
      <Circle cx={24} cy={31} fill={STROKE} r={2.4} />
      <Circle cx={40} cy={31} fill={STROKE} r={2.4} />
      <Ellipse cx={32} cy={42} fill="none" rx={8} ry={6} stroke={STROKE} strokeWidth={S} />
      <Path d="M32 42 L32 46" fill="none" stroke={STROKE} strokeLinecap="round" strokeWidth={S * 0.75} />
    </Svg>
  );
}

function BearFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Circle cx={14} cy={16} fill="none" r={8} stroke={STROKE} strokeWidth={S} />
      <Circle cx={50} cy={16} fill="none" r={8} stroke={STROKE} strokeWidth={S} />
      <Circle cx={32} cy={35} fill="none" r={25} stroke={STROKE} strokeWidth={S} />
      <Circle cx={23} cy={32} fill={STROKE} r={2.6} />
      <Circle cx={41} cy={32} fill={STROKE} r={2.6} />
      <Ellipse cx={32} cy={43} fill="none" rx={9} ry={7} stroke={STROKE} strokeWidth={S} />
      <Ellipse cx={32} cy={41} fill={STROKE} rx={3.4} ry={2.6} />
    </Svg>
  );
}

function PigFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Rect fill="none" height={40} rx={18} stroke={STROKE} strokeWidth={S} width={44} x={10} y={16} />
      <Path d="M14 16 L20 8 L26 18 Z" fill="none" stroke={STROKE} strokeLinejoin="round" strokeWidth={S} />
      <Path d="M50 16 L44 8 L38 18 Z" fill="none" stroke={STROKE} strokeLinejoin="round" strokeWidth={S} />
      <Circle cx={23} cy={33} fill={STROKE} r={2.6} />
      <Circle cx={41} cy={33} fill={STROKE} r={2.6} />
      <Rect fill="none" height={14} rx={7} stroke={STROKE} strokeWidth={S} width={20} x={22} y={40} />
      <Circle cx={27} cy={47} fill={STROKE} r={1.8} />
      <Circle cx={37} cy={47} fill={STROKE} r={1.8} />
    </Svg>
  );
}

function SheepFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Path
        d="M10 22 Q6 12 16 10 Q18 4 26 8 Q32 2 38 8 Q46 4 48 10 Q58 12 54 22 Q60 26 54 32 Q58 40 50 42 Q52 50 42 52 Q40 58 32 56 Q24 58 22 52 Q12 50 14 42 Q6 40 10 32 Q4 26 10 22 Z"
        fill="none"
        stroke={STROKE}
        strokeLinejoin="round"
        strokeWidth={S * 0.8}
      />
      <Ellipse cx={32} cy={34} fill="none" rx={16} ry={15} stroke={STROKE} strokeWidth={S} />
      <Circle cx={25} cy={32} fill={STROKE} r={2.4} />
      <Circle cx={39} cy={32} fill={STROKE} r={2.4} />
      <Path
        d="M27 41 Q32 44 37 41"
        fill="none"
        stroke={STROKE}
        strokeLinecap="round"
        strokeWidth={S * 0.75}
      />
    </Svg>
  );
}

function FrogFace({ size }: FaceProps) {
  return (
    <Svg height={size} viewBox="0 0 64 64" width={size}>
      <Circle cx={18} cy={18} fill="none" r={9} stroke={STROKE} strokeWidth={S} />
      <Circle cx={46} cy={18} fill="none" r={9} stroke={STROKE} strokeWidth={S} />
      <Circle cx={18} cy={18} fill={STROKE} r={2.6} />
      <Circle cx={46} cy={18} fill={STROKE} r={2.6} />
      <Ellipse cx={32} cy={38} fill="none" rx={26} ry={20} stroke={STROKE} strokeWidth={S} />
      <Path d="M14 40 Q32 50 50 40" fill="none" stroke={STROKE} strokeLinecap="round" strokeWidth={S} />
      <Circle cx={26} cy={33} fill={STROKE} r={1.6} />
      <Circle cx={38} cy={33} fill={STROKE} r={1.6} />
    </Svg>
  );
}

const ANIMAL_FACE_COMPONENTS: Record<AnimalFaceId, (props: FaceProps) => React.JSX.Element> = {
  bear: BearFace,
  cat: CatFace,
  dog: DogFace,
  frog: FrogFace,
  koala: KoalaFace,
  lion: LionFace,
  monkey: MonkeyFace,
  panda: PandaFace,
  pig: PigFace,
  sheep: SheepFace,
};

export function AnimalFace({ animal, size }: { animal: AnimalFaceId; size: number }) {
  const Face = ANIMAL_FACE_COMPONENTS[animal];
  return <Face size={size} />;
}
