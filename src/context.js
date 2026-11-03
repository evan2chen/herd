import { HerdError } from './errors.js';
import { paneGet } from './herdr.js';

export function anchorContext() {
  const { HERDR_ENV, HERDR_PANE_ID } = process.env;
  if (HERDR_ENV !== '1' || !HERDR_PANE_ID) {
    throw new HerdError('not_in_herdr', 'herd must run inside a Herdr pane', {
      help: ['Start the orchestrator inside Herdr so HERDR_ENV=1 and HERDR_PANE_ID are set'],
    });
  }
  const pane = paneGet(HERDR_PANE_ID);
  return { pane: pane.pane_id, tab: pane.tab_id, workspace: pane.workspace_id };
}
