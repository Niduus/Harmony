// What Harmony lets you do in a chat right now. Reading and sending plain text is always on.
// Each action below is switched on in the phase that gives it its own safety limits
// (see SAFETY.md), and only with the project owner's approval.

export const CAN = {
  react: false,
  reply: false,
  edit: false,
  delete: false,
  pin: false,
  upload: false,
  typing: false,
  mentionSearch: false,
};
