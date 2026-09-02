import express from 'express';

export const createApp = (): express.Express => {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
};
