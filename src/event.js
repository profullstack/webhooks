// CloudEvents 1.0 structured-mode JSON envelope.
// Spec: https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md

import { randomUUID } from 'node:crypto';

export const DEFAULT_SOURCE = 'urn:profullstack:webhooks';

export function createEvent(type, data, { source, subject, id, time } = {}) {
  if (!type || typeof type !== 'string') throw new Error('createEvent: type required');
  const event = {
    specversion: '1.0',
    id: id ?? randomUUID(),
    type,
    source: source ?? DEFAULT_SOURCE,
  };
  if (subject !== undefined) event.subject = subject;
  event.time = time instanceof Date ? time.toISOString() : (time ?? new Date().toISOString());
  event.datacontenttype = 'application/json';
  event.data = data === undefined ? null : data;
  return event;
}
