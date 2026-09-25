/**
 * The Adika brand mark (from the supplied logo SVG). The wordmark uses
 * currentColor-driven fills so it stays legible in dark mode.
 */
export function AdikaLogo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <svg viewBox={showWordmark ? '10 8 290 104' : '28 8 90 104'} className={className} role="img" aria-label="Adika PDF Editor">
      <defs>
        <linearGradient id="adikaBlue" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0284C7" />
          <stop offset="100%" stopColor="#38BDF8" />
        </linearGradient>
        <linearGradient id="adikaAccent" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#059669" />
          <stop offset="100%" stopColor="#10B981" />
        </linearGradient>
      </defs>
      <g transform="translate(10, 10)">
        <path d="M20 5C20 2 22 0 25 0L70 0L95 25L95 95C95 98 93 100 90 100L25 100C22 100 20 98 20 95Z" fill="url(#adikaBlue)" />
        <path d="M70 0L70 20C70 23 72 25 75 25L95 25Z" fill="#0369A1" opacity="0.6" />
        <path d="M57.5 28L73 72C74 75 72 78 68 78L62 78L57.5 64L42.5 64L38 78L32 78C28 78 26 75 27 72L42.5 28C44.5 22 55.5 22 57.5 28ZM50 38L45.5 54L54.5 54Z" fill="#FFFFFF" />
        <path d="M64 62L78 76L86 68L72 54Z" fill="url(#adikaAccent)" />
        <circle cx="81" cy="71" r="2" fill="#FFFFFF" />
      </g>
      {showWordmark ? (
        <>
          <text x="130" y="68" fontFamily="'Segoe UI', 'Inter', sans-serif" fontSize="52" fontWeight="800" letterSpacing="-1" className="fill-[#0F172A] dark:fill-slate-100">
            Adika
          </text>
          <text x="132" y="94" fontFamily="'Segoe UI', 'Inter', sans-serif" fontSize="16" fontWeight="700" letterSpacing="4.5" fill="#0284C7" className="dark:fill-sky-400">
            PDF EDITOR
          </text>
          <circle cx="282" cy="60" r="5" fill="url(#adikaAccent)" />
        </>
      ) : null}
    </svg>
  );
}
