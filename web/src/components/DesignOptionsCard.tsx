import type { DesignBlock, DesignOption } from '@atelier/contracts';
import { Check, Maximize2, Sparkles } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { workspaceImageUrl } from '../api';
import { ModalShell, primaryBtnStyle, secondaryBtnStyle } from './modals/ModalShell';

/**
 * Previews run inside <iframe sandbox="allow-scripts">: no same-origin access to Atelier, and a CSP
 * that blocks every network request (self-contained mockups only), form posts and navigation.
 */
const CSP_HTML =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";
const CSP_SVG = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'";
const BLOCK_NAV = "document.addEventListener('click',function(e){if(e.target&&e.target.closest&&e.target.closest('a'))e.preventDefault()},true)";

function buildSrcDoc(option: DesignOption): string {
  if (option.kind === 'svg') {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP_SVG}"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#15151b}svg{max-width:92%;max-height:92%}</style></head><body>${option.content}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP_HTML}"><style>html,body{margin:0}</style><script>${BLOCK_NAV}</script></head><body>${option.content}</body></html>`;
}

function imageSrc(src: string): string | null {
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(src)) return src;
  if (/^[a-zA-Z]:[\\/]|^\//.test(src)) return workspaceImageUrl(src);
  return null;
}

const OptionPreview = memo(function OptionPreview({
  option,
  maxScale = 1,
}: {
  option: DesignOption;
  maxScale?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.35);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(maxScale, el.clientWidth / option.width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [option.width, maxScale]);

  if (option.kind === 'image') {
    const src = option.src ? imageSrc(option.src) : null;
    return (
      <div
        ref={hostRef}
        style={{ width: '100%', aspectRatio: `${option.width} / ${option.height}`, background: '#15151b', display: 'grid', placeItems: 'center' }}
      >
        {src ? (
          <img src={src} alt={option.label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Gambar tidak bisa ditampilkan</span>
        )}
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      style={{
        position: 'relative',
        width: '100%',
        height: option.height * scale,
        overflow: 'hidden',
        background: '#15151b',
      }}
    >
      <iframe
        title={option.label}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={buildSrcDoc(option)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: option.width,
          height: option.height,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          background: option.kind === 'svg' ? '#15151b' : '#fff',
        }}
      />
    </div>
  );
});

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

export function DesignOptionsCard({
  block,
  onChoose,
}: {
  block: DesignBlock;
  onChoose: (option: DesignOption) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [zoom, setZoom] = useState<DesignOption | null>(null);

  const choose = (o: DesignOption) => {
    setChosen(o.id);
    setZoom(null);
    onChoose(o);
  };

  return (
    <div
      className="glass glass-agent msg-enter"
      style={{ alignSelf: 'stretch', borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={14} strokeWidth={1.6} style={{ color: 'var(--agent-purple)' }} />
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{block.title}</div>
          {block.ask && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{block.ask}</div>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
        {block.options.map((o) => {
          const isChosen = chosen === o.id;
          return (
            <div
              key={o.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 12,
                overflow: 'hidden',
                background: 'var(--surface-1)',
                border: `1px solid ${isChosen ? 'var(--agent-purple)' : 'var(--border-default)'}`,
              }}
            >
              <button
                type="button"
                onClick={() => setZoom(o)}
                title="Perbesar"
                style={{ display: 'block', padding: 0, border: 0, background: 'none', cursor: 'zoom-in', position: 'relative' }}
              >
                <OptionPreview option={o} />
                {/* covers the iframe so a click enlarges instead of interacting with the thumbnail */}
                <span style={{ position: 'absolute', inset: 0 }} />
              </button>
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      minWidth: 20,
                      height: 20,
                      padding: '0 5px',
                      borderRadius: 6,
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                      background: 'var(--surface-3)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {o.id}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{o.label}</span>
                </div>
                {o.summary && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: '17px' }}>{o.summary}</div>}
                {o.pros && (
                  <div style={{ fontSize: 11.5, lineHeight: '16px', color: 'var(--text-secondary)' }}>
                    <span style={{ ...labelStyle, color: 'var(--agent-green)' }}>Pros </span>
                    {o.pros}
                  </div>
                )}
                {o.cons && (
                  <div style={{ fontSize: 11.5, lineHeight: '16px', color: 'var(--text-secondary)' }}>
                    <span style={{ ...labelStyle, color: 'var(--agent-amber)' }}>Cons </span>
                    {o.cons}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => choose(o)}
                    style={{ ...primaryBtnStyle, height: 30, padding: '0 12px', fontSize: 12 }}
                  >
                    {isChosen ? (
                      <>
                        <Check size={13} strokeWidth={2} /> Terpilih
                      </>
                    ) : (
                      `Pilih opsi ${o.id}`
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(o)}
                    style={{ ...secondaryBtnStyle, height: 30, padding: '0 10px', fontSize: 12 }}
                  >
                    <Maximize2 size={12} strokeWidth={1.6} /> Perbesar
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {zoom &&
        createPortal(
        <ModalShell title={`Opsi ${zoom.id} · ${zoom.label}`} subtitle={zoom.summary} width={1120} onClose={() => setZoom(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-default)' }}>
              <OptionPreview option={zoom} maxScale={1.4} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setZoom(null)} style={secondaryBtnStyle}>
                Tutup
              </button>
              <button type="button" onClick={() => choose(zoom)} style={primaryBtnStyle}>
                Pilih opsi {zoom.id}
              </button>
            </div>
          </div>
        </ModalShell>,
          document.body,
        )}
    </div>
  );
}

export function DesignPendingCard({ title }: { title?: string }) {
  return (
    <div
      className="glass glass-agent"
      style={{
        alignSelf: 'stretch',
        borderRadius: 16,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 12.5,
        color: 'var(--text-secondary)',
      }}
    >
      <Sparkles size={14} strokeWidth={1.6} style={{ color: 'var(--agent-purple)' }} />
      Menyiapkan opsi desain{title ? ` — ${title}` : ''}…
    </div>
  );
}
