// The user-supplied library artwork is used as a mask so it inherits the
// same currentColor and hover treatment as the keyboard icon.

export function HistoryIcon({ size = 34 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "block",
        width: size,
        height: size,
        backgroundColor: "currentColor",
        WebkitMask: "url('/history-icon.png') center / contain no-repeat",
        mask: "url('/history-icon.png') center / contain no-repeat",
      }}
    />
  );
}

export default HistoryIcon;
