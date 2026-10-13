const SETTINGS_ID = 'GLOBAL_APP_FEATURES';
const COLLECTION = 'app_feature_settings';

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

function defaults() {
  return {
    otpVerificationEnabled: envBool('CUSTOMER_REGISTER_REQUIRE_OTP', true),
    legalInformationEnabled: true,
  };
}

function normalize(doc) {
  const base = defaults();
  const x = doc || {};
  return {
    otpVerificationEnabled:
      typeof x.otpVerificationEnabled === 'boolean'
        ? x.otpVerificationEnabled
        : base.otpVerificationEnabled,
    legalInformationEnabled:
      typeof x.legalInformationEnabled === 'boolean'
        ? x.legalInformationEnabled
        : base.legalInformationEnabled,
    updatedAt: x.updatedAt || null,
  };
}

async function getAppFeatureSettings(db) {
  if (!db) return normalize(null);
  const doc = await db.collection(COLLECTION).findOne({ _id: SETTINGS_ID });
  return normalize(doc);
}

async function setAppFeatureSettings(db, patch, actorId = null) {
  const current = await getAppFeatureSettings(db);
  const next = {
    otpVerificationEnabled:
      typeof patch?.otpVerificationEnabled === 'boolean'
        ? patch.otpVerificationEnabled
        : current.otpVerificationEnabled,
    legalInformationEnabled:
      typeof patch?.legalInformationEnabled === 'boolean'
        ? patch.legalInformationEnabled
        : current.legalInformationEnabled,
    updatedAt: new Date(),
    updatedBy: actorId || null,
  };

  await db.collection(COLLECTION).updateOne(
    { _id: SETTINGS_ID },
    {
      $set: next,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  return normalize(next);
}

module.exports = {
  SETTINGS_ID,
  COLLECTION,
  defaults,
  normalize,
  getAppFeatureSettings,
  setAppFeatureSettings,
};
