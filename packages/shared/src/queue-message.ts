export type QueueMessage = {
  eventId: string;
  tenantId: string;
  type: string;
  payload: unknown | null;
  payloadS3Key: string | null;
};
