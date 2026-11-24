// A consumer registers a component with the same renderer that displays its connector data.
import { defineComponent, html, mountShell, type ShellEvent } from '@matapao/vindu';

declare global { interface Window { sendToSession(event: ShellEvent): Promise<boolean> } }
const gauge = defineComponent({
  name: 'DepthGauge', tag: 'station-depth', props: { rows: 'value' },
  render: ({ rows }) => html`<output>${rows[0].depth} m at ${rows[0].station}</output>`,
});
export const shell = mountShell(document.querySelector('main')!, {
  components: [gauge], tokens: { accent: '#315971' }, metrics: { density: 0.8 },
  onEvent: event => { void window.sendToSession(event); },
});
