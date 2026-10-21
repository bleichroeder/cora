import { icons, type LucideProps } from 'lucide-react';
import { FAM, type Family } from '@cora/shared';

export function Icon({ name, size = 12, ...rest }: { name: string; size?: number } & Omit<LucideProps, 'ref'>) {
  const C = (icons as Record<string, React.ComponentType<LucideProps>>)[name] ?? icons.Wrench;
  return <C size={size} strokeWidth={2} {...rest} />;
}

/** Family-tinted icon tile used in transcript rows, the rail and the needs-you panel. */
export function Tile({ name, family, failed, live, size = 18 }: { name: string; family: Family; failed?: boolean; live?: boolean; size?: number }) {
  const c = failed ? FAM.human.c : FAM[family].c;
  return (
    <span className={`tile${live ? ' live' : ''}`} style={{ ['--f' as any]: c, width: size, height: size }}>
      <Icon name={failed ? 'TriangleAlert' : name} size={Math.round(size * 0.66)} />
    </span>
  );
}

export const familyColor = (f: Family) => FAM[f].c;
