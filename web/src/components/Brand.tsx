/** tradoor's mark and name: the desktop's top bar, and a phone's chart toolbar in its place. */
export function Brand() {
  return (
    <div class="brand">
      <svg viewBox="0 0 16 16" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1">
        <rect x="1.8" y="3" width="7.6" height="10" rx="1" stroke-opacity="0.8" />
        <path d="M9.4 3 L13.6 1.2 L13.6 14.8 L9.4 13 Z" fill="currentColor" fill-opacity="0.32" stroke-linejoin="round" />
        <rect x="3.3" y="7.6" width="1.7" height="3.4" fill="currentColor" stroke="none" />
        <rect x="6.2" y="5.6" width="1.7" height="5.2" fill="currentColor" stroke="none" />
      </svg>
      <span>TRADOOR</span>
    </div>
  );
}
