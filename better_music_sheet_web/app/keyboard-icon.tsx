// The mark for the Play page, used by the header nav and the results page.
// Drawn as line art in currentColor so it inherits whatever button it sits
// in, the same way the rest of the nav icons behave.

export function KeyboardIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 16"
      width={size}
      height={(size * 16) / 24}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="22" height="14" rx="2.5" />
      {/* White-key divisions only reach the front half, so the filled black
          keys above them read as sitting between them. */}
      <path d="M6.5 8.6V15M12 8.6V15M17.5 8.6V15" />
      <rect x="4.5" y="1" width="4" height="7.6" rx="1" fill="currentColor" stroke="none" />
      <rect x="10" y="1" width="4" height="7.6" rx="1" fill="currentColor" stroke="none" />
      <rect x="15.5" y="1" width="4" height="7.6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default KeyboardIcon;
