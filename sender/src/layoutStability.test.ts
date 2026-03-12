import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('layout stability smoke checks', () => {
  it('sender control panel keeps Clear QR control in the always-available action row', () => {
    const mainTs = readFileSync(resolve(__dirname, './main.ts'), 'utf8');
    expect(mainTs).toContain('<button id="clear-btn" type="button" data-persistent-control="true">Clear QR</button>');
    expect(mainTs).toContain("clearButton.addEventListener('click', () => clearQrOutput());");
  });

  it('sender QR geometry remains square and stage is full-height', () => {
    const css = readFileSync(resolve(__dirname, './style.css'), 'utf8');
    expect(css).toContain('.layout { min-height: 100vh; display: flex; flex-direction: row; gap: 0.8rem; padding: 0.8rem; align-items: flex-start;');
    expect(css).toContain('.panel { width: min(360px, 100%);');
    expect(css).toContain('position: sticky; top: 0.8rem; max-height: calc(100vh - 1.6rem); overflow: auto;');
    expect(css).toContain('@media (max-width: 980px) {');
    expect(css).toContain('.layout { flex-direction: column; align-items: center; }');
    expect(css).toContain('.panel { width: min(960px, 100%); position: static; max-height: none; overflow: visible; }');
    expect(css).toContain('.qr-shell { --qr-size: 400px;');
    expect(css).toContain('width: min(var(--qr-size), calc(100vw - 2rem), 88vmin);');
    expect(css).toContain('height: min(var(--qr-size), calc(100vw - 2rem), 88vmin);');
    expect(css).toContain('#qr-canvas { width: 100%; height: 100%;');
  });

  it('receiver scan geometry remains square and overlay is fixed inset', () => {
    const css = readFileSync(resolve(__dirname, '../../receiver/src/style.css'), 'utf8');
    expect(css).toContain('.video-wrap { width: min(88vmin, calc(100vw - 2rem)); height: min(88vmin, calc(100vw - 2rem));');
    expect(css).toContain('.scan-overlay { position: absolute; inset: 12%;');
  });
});
