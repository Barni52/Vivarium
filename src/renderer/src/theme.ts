// Global CSS ported verbatim from the design mockup (scratchpad/page.html):
// palette custom-props, keyframes, scrollbars. Injected once at startup.

export const GLOBAL_CSS = `
  *{box-sizing:border-box}
  html,body,#root{margin:0;padding:0;height:100%;background:#0f141b}
  :root{
    --win:#0e131a;--bg:#0f141b;--sidebar:#12171f;--panel:#171d26;--field:#141a22;--field-2:#1c232d;
    --row-hover:#161c25;--sel:#1d2c3f;--border:#2a333f;--border-2:#1b222b;
    --text:#eef1f5;--text-2:#9aa6b6;--text-3:#6a7686;
    --accent:#5a769f;--accent-2:#6d88ad;--danger:#fa4d56;--overlay:rgba(2,4,7,.66);
    --terminal-bg:#0a0d12;--terminal-text:#c7cfda;
  }
  body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--text)}
  ::selection{background:rgba(69,137,255,.32)}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:var(--border);border:2px solid transparent;background-clip:padding-box}
  ::-webkit-scrollbar-thumb:hover{background:var(--text-3)}
  input,button,textarea{font-family:inherit}
  @keyframes vpulse{0%{box-shadow:0 0 0 0 rgba(66,190,101,.5)}70%{box-shadow:0 0 0 5px rgba(66,190,101,0)}100%{box-shadow:0 0 0 0 rgba(66,190,101,0)}}
  @keyframes vover{from{opacity:0}to{opacity:1}}
  @keyframes vdlg{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @keyframes vpop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
`

export const ACCENT: Record<string, string> = {
  agent: '#a56eff',
  'container-shell': '#3ddbd9',
  'host-shell': '#42be65'
}

export function typeLabel(type: string): string {
  return type === 'agent'
    ? 'Agent'
    : type === 'container-shell'
      ? 'Terminal · container'
      : 'Terminal · host'
}

export function typeSubtitle(type: string): string {
  return type === 'agent'
    ? 'Claude Code in the container'
    : type === 'container-shell'
      ? 'bash inside the container'
      : 'PowerShell in the project folder'
}
