interface CandidateAvatarProps {
  name: string;
  size?: number;
}

const AVATAR_COLORS = [
  { bg: '#F5E6D0', text: '#2C1A0F' },
  { bg: '#EAC99A', text: '#2C1A0F' },
  { bg: '#D49B68', text: '#2C1A0F' },
  { bg: '#BA7840', text: '#FFFCF8' },
  { bg: '#9A5C2E', text: '#FFFCF8' },
  { bg: '#7A4520', text: '#FFFCF8' },
] as const;

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase('en-US');
  return `${words[0][0]}${words[words.length - 1][0]}`.toLocaleUpperCase('en-US');
}

export function CandidateAvatar({ name, size = 48 }: CandidateAvatarProps) {
  const hash = Array.from(name).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0);
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        backgroundColor: color.bg,
        color: color.text,
        fontSize: Math.round(size * 0.35),
      }}
    >
      {initialsFor(name)}
    </span>
  );
}
