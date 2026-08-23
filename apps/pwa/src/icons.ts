const common = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const paths: Record<string, string> = {
  activity: '<path d="M3 12h4l2.2-6 4.1 12 2.5-6H21"/>',
  devices: '<rect x="4" y="3" width="16" height="12" rx="2"/><path d="M8 21h8M12 15v6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.1A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.39.28.6.66.6 1.1v3.8c0 .44-.21.82-.6 1.1Z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/>',
  play: '<circle cx="12" cy="12" r="8"/><path d="m10 9 5 3-5 3Z"/>',
  attention: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
  completed: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16.5 9"/>',
  failed: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  inactive: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  shield: '<path d="M12 3 5 6v5c0 4.6 2.9 8.1 7 10 4.1-1.9 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  wifi: '<path d="M5 12.6a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01"/>',
  empty: '<path d="M4 7h16v12H4zM8 7V5h8v2"/><path d="M9 13h6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/>',
};

export function icon(name: keyof typeof paths, size = 20): string {
  return `<svg ${common.replaceAll('20', String(size))}>${paths[name] ?? ""}</svg>`;
}
