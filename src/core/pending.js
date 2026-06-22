export const pendingActions = new Map();

export function generateActionId() {
  return Math.random().toString(36).substring(2, 10);
}
