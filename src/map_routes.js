'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createMapService, createFallbackRoute } = require('./map_service');

function createMapRouter({ mapService = createMapService() } = {}) {
  const router = express.Router();
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: Math.max(10, Number(process.env.MAP_API_RATE_LIMIT_PER_MINUTE || 60)),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));

  router.get('/config', (_req, res) => res.json(mapService.publicConfig()));

  router.get('/search', async (req, res) => {
    try {
      const results = await mapService.search(req.query.q, { limit: req.query.limit, countryCode: req.query.country || 'vn' });
      return res.json({ provider: 'OPENSTREETMAP', results });
    } catch (error) {
      const status = error instanceof RangeError || error instanceof TypeError ? 400 : 502;
      return res.status(status).json({ code: 'MAP_SEARCH_FAILED', message: error.message });
    }
  });

  router.get('/reverse', async (req, res) => {
    try {
      const place = await mapService.reverse(req.query.lat, req.query.lon);
      return res.json({ provider: 'OPENSTREETMAP', place });
    } catch (error) {
      const status = error instanceof RangeError || error instanceof TypeError ? 400 : 502;
      return res.status(status).json({ code: 'MAP_REVERSE_FAILED', message: error.message });
    }
  });

  router.get('/route', async (req, res) => {
    try {
      const route = await mapService.route(req.query.fromLat, req.query.fromLon, req.query.toLat, req.query.toLon, { vehicleType:req.query.vehicleType || 'MOTORBIKE', mode:req.query.mode || 'BALANCED' });
      return res.json({ provider: 'OPENSTREETMAP', route });
    } catch (error) {
      try {
        const route = createFallbackRoute(req.query.fromLat, req.query.fromLon, req.query.toLat, req.query.toLon);
        return res.json({ provider: 'FALLBACK', warning: error.message, route });
      } catch (validationError) {
        return res.status(400).json({ code: 'MAP_ROUTE_FAILED', message: validationError.message });
      }
    }
  });

  return router;
}

module.exports = { createMapRouter };
