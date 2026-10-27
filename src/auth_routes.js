const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  override: true,
});
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendOtpSms, assertOtpThrottle } = require('./otp_delivery_service');
const { getAppFeatureSettings } = require('./app_feature_settings');
const { ObjectId, GridFSBucket } = require('mongodb');

const router = express.Router();

const JWT_ACCESS_SECRET =
  String(process.env.JWT_ACCESS_SECRET || '');

const ACCESS_TTL_SECONDS =
  Math.max(
    300,
    Number(
      process.env.JWT_ACCESS_TTL_SECONDS ||
      900,
    ),
  );

const REFRESH_DAYS =
  Math.max(
    1,
    Number(
      process.env.AUTH_REFRESH_DAYS ||
      30,
    ),
  );

const OTP_MINUTES =
  Math.max(
    1,
    Number(
      process.env.AUTH_OTP_MINUTES ||
      5,
    ),
  );

const DEV_SHOW_OTP =
  String(process.env.AUTH_DEV_SHOW_OTP || 'false').toLowerCase() === 'true' &&
  String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

const now = () => new Date();

function normalizePhone(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .trim();
}

function validatePhone(phone) {
  return /^0\d{9}$/.test(phone);
}

function normalizeEmail(value) {
  const email =
    String(value || '')
      .trim()
      .toLowerCase();

  return email || null;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function randomRefreshToken() {
  return crypto
    .randomBytes(64)
    .toString('hex');
}

function generateOtp() {
  return String(
    crypto.randomInt(
      100000,
      1000000,
    ),
  );
}

function publicUser(user) {
  return {
    id: String(user._id),

    phone:
      user.phone,

    fullName:
      user.fullName,

    email:
      user.email || null,

    avatarUrl:
      user.avatarUrl || null,

    status:
      user.status,

    roles:
      Array.isArray(user.roles)
        ? user.roles
        : [],
  };
}

function ensureSecret() {
  if (
    !JWT_ACCESS_SECRET ||
    JWT_ACCESS_SECRET.length < 32
  ) {
    throw new Error(
      'JWT_ACCESS_SECRET chưa được cấu hình an toàn trong .env.',
    );
  }
}

function createAccessToken(user) {
  ensureSecret();

  return jwt.sign(
    {
      phone:
        user.phone,

      roles:
        Array.isArray(user.roles)
          ? user.roles
          : [],
    },

    JWT_ACCESS_SECRET,

    {
      subject:
        String(user._id),

      issuer:
        'th79-imove',

      audience:
        'th79-imove-apps',

      expiresIn:
        ACCESS_TTL_SECONDS,
    },
  );
}

async function ensureIndexes(db) {
  try {
    await db
      .collection('users')
      .createIndex(
        {
          phone: 1,
        },
        {
          unique: true,
        },
      );

    await db
      .collection('auth_sessions')
      .createIndex(
        {
          tokenHash: 1,
        },
        {
          unique: true,
        },
      );

    await db
      .collection('auth_sessions')
      .createIndex({
        userId: 1,
        revokedAt: 1,
      });

    await db
      .collection('auth_sessions')
      .createIndex(
        {
          expiresAt: 1,
        },
        {
          expireAfterSeconds: 0,
        },
      );

    await db
      .collection('otp_verifications')
      .createIndex({
        phone: 1,
        purpose: 1,
        createdAt: -1,
      });

    await db
      .collection('otp_verifications')
      .createIndex(
        {
          expiresAt: 1,
        },
        {
          expireAfterSeconds: 0,
        },
      );
  } catch (error) {
    console.warn(
      '[AUTH INDEX]',
      error.message,
    );
  }
}

async function issueTokens({
  db,
  user,
  req,
}) {
  const accessToken =
    createAccessToken(user);

  const refreshToken =
    randomRefreshToken();

  const tokenHash =
    sha256(refreshToken);

  const createdAt =
    now();

  const expiresAt =
    new Date(
      Date.now() +
      REFRESH_DAYS *
      24 *
      60 *
      60 *
      1000,
    );

  await db
    .collection('auth_sessions')
    .insertOne({
      userId:
        user._id,

      tokenHash,

      userAgent:
        String(
          req.headers[
            'user-agent'
          ] || '',
        ),

      ip:
        req.ip || null,

      createdAt,

      lastUsedAt:
        createdAt,

      expiresAt,

      revokedAt:
        null,
    });

  return {
    accessToken,

    refreshToken,

    tokenType:
      'Bearer',

    expiresIn:
      ACCESS_TTL_SECONDS,

    refreshExpiresAt:
      expiresAt.toISOString(),
  };
}

function createAuthenticate(
  getDb,
) {
  return async function authenticate(
    req,
    res,
    next,
  ) {
    try {
      ensureSecret();

      const header =
        String(
          req.headers.authorization ||
          '',
        );

      if (
        !header.startsWith(
          'Bearer ',
        )
      ) {
        return res
          .status(401)
          .json({
            message:
              'Thiếu Access Token.',
          });
      }

      const token =
        header.substring(7);

      const payload =
        jwt.verify(
          token,
          JWT_ACCESS_SECRET,
          {
            issuer:
              'th79-imove',

            audience:
              'th79-imove-apps',
          },
        );

      const userId =
        new ObjectId(
          payload.sub,
        );

      const db =
        getDb();

      if (!db) {
        return res
          .status(503)
          .json({
            message:
              'Database chưa sẵn sàng.',
          });
      }

      const user =
        await db
          .collection('users')
          .findOne({
            _id:
              userId,

            status:
              'ACTIVE',
          });

      if (!user) {
        return res
          .status(401)
          .json({
            message:
              'Tài khoản không tồn tại hoặc đã bị khóa.',
          });
      }

      req.auth = {
        user,
        payload,
      };

      return next();
    } catch (error) {
      if (
        error.name ===
        'TokenExpiredError'
      ) {
        return res
          .status(401)
          .json({
            code:
              'TOKEN_EXPIRED',

            message:
              'Phiên đăng nhập đã hết hạn.',
          });
      }

      return res
        .status(401)
        .json({
          code:
            'INVALID_TOKEN',

          message:
            'Access Token không hợp lệ.',
        });
    }
  };
}

function createAuthRouter({
  getDb,
}) {
  const authenticate =
    createAuthenticate(
      getDb,
    );

  router.use(
    async (
      req,
      res,
      next,
    ) => {
      const db =
        getDb();

      if (!db) {
        return res
          .status(503)
          .json({
            message:
              'MongoDB Atlas chưa sẵn sàng.',
          });
      }

      await ensureIndexes(
        db,
      );

      next();
    },
  );

  // ============================================
  // CUSTOMER REGISTER
  // ============================================

  router.post(
    '/register',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const fullName =
          String(
            req.body
              ?.fullName ||
            '',
          ).trim();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        const email =
          normalizeEmail(
            req.body
              ?.email,
          );

        const password =
          String(
            req.body
              ?.password ||
            '',
          );

        if (
          fullName.length < 2
        ) {
          return res
            .status(400)
            .json({
              message:
                'Họ tên không hợp lệ.',
            });
        }

        if (
          !validatePhone(
            phone,
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                'Số điện thoại phải gồm 10 số và bắt đầu bằng 0.',
            });
        }

        if (
          password.length < 6
        ) {
          return res
            .status(400)
            .json({
              message:
                'Mật khẩu phải có ít nhất 6 ký tự.',
            });
        }

        const verificationToken = String(req.body?.verificationToken || '').trim();
        const requireOtp = (await getAppFeatureSettings(db)).otpVerificationEnabled;
        if (requireOtp) {
          if (!verificationToken) {
            return res.status(400).json({ code: 'OTP_REQUIRED', message: 'Vui lòng xác thực OTP số điện thoại trước khi đăng ký.' });
          }
          try {
            ensureSecret();
            const verified = jwt.verify(verificationToken, JWT_ACCESS_SECRET, {
              issuer: 'th79-imove',
              audience: 'th79-imove-apps',
            });
            if (verified?.kind !== 'OTP_VERIFICATION' || verified?.bypassedBecauseOtpDisabled === true || normalizePhone(verified?.phone) !== phone || !['CUSTOMER_PHONE_VERIFY','PHONE_VERIFY'].includes(String(verified?.purpose || '').toUpperCase())) {
              return res.status(400).json({ code: 'OTP_INVALID', message: 'Phiên xác thực OTP không hợp lệ.' });
            }
          } catch (_) {
            return res.status(400).json({ code: 'OTP_EXPIRED', message: 'Phiên xác thực OTP đã hết hạn. Vui lòng gửi lại mã.' });
          }
        }

        let user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        // Nếu booking trước đây đã tự tạo user
        // passwordHash = null,
        // cho phép khách hàng nhận lại tài khoản.
        if (
          user &&
          user.passwordHash
        ) {
          return res
            .status(409)
            .json({
              message:
                'Số điện thoại này đã có tài khoản.',
            });
        }

        const passwordHash =
          await bcrypt.hash(
            password,
            12,
          );

        const changedAt =
          now();

        if (user) {
          await db
            .collection('users')
            .updateOne(
              {
                _id:
                  user._id,
              },
              {
                $set: {
                  fullName,
                  email,
                  passwordHash,

                  status:
                    'ACTIVE',

                  updatedAt:
                    changedAt,
                },

                $addToSet: {
                  roles:
                    'CUSTOMER',
                },
              },
            );

          user =
            await db
              .collection('users')
              .findOne({
                _id:
                  user._id,
              });
        } else {
          const doc = {
            phone,
            fullName,
            email,

            passwordHash,

            avatarUrl:
              null,

            status:
              'ACTIVE',

            roles: [
              'CUSTOMER',
            ],

            lastLoginAt:
              changedAt,

            createdAt:
              changedAt,

            updatedAt:
              changedAt,
          };

          const result =
            await db
              .collection('users')
              .insertOne(
                doc,
              );

          user = {
            ...doc,

            _id:
              result.insertedId,
          };
        }

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res
          .status(201)
          .json({
            user:
              publicUser(
                user,
              ),

            ...tokens,
          });
      } catch (error) {
        console.error(
          '[AUTH REGISTER]',
          error,
        );

        if (
          error.code ===
          11000
        ) {
          return res
            .status(409)
            .json({
              message:
                'Số điện thoại này đã tồn tại.',
            });
        }

        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // LOGIN CUSTOMER / DRIVER
  // ============================================

  router.post(
    '/login',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        const password =
          String(
            req.body
              ?.password ||
            '',
          );

        const requestedRole =
          String(
            req.body
              ?.role ||
            '',
          )
            .trim()
            .toUpperCase();

        const user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        if (
          !user ||
          !user.passwordHash
        ) {
          return res
            .status(401)
            .json({
              message:
                'Số điện thoại hoặc mật khẩu không đúng.',
            });
        }

        if (
          user.status !==
          'ACTIVE'
        ) {
          return res
            .status(403)
            .json({
              message:
                'Tài khoản đang bị khóa.',
            });
        }

        const passwordOk =
          await bcrypt.compare(
            password,
            user.passwordHash,
          );

        if (!passwordOk) {
          return res
            .status(401)
            .json({
              message:
                'Số điện thoại hoặc mật khẩu không đúng.',
            });
        }

        const roles =
          Array.isArray(
            user.roles,
          )
            ? user.roles
            : [];

        if (
          requestedRole &&
          !roles.includes(
            requestedRole,
          )
        ) {
          return res
            .status(403)
            .json({
              message:
                `Tài khoản không có quyền ${requestedRole}.`,
            });
        }

        let driver = null;
        let vehicle = null;

        if (
          roles.includes(
            'DRIVER',
          )
        ) {
          driver =
            await db
              .collection('drivers')
              .findOne({
                userId:
                  user._id,
              });

          if (driver) {
            vehicle =
              await db
                .collection('vehicles')
                .findOne({
                  driverId:
                    driver._id,
                });
          }
        }

        await db
          .collection('users')
          .updateOne(
            {
              _id:
                user._id,
            },
            {
              $set: {
                lastLoginAt:
                  now(),

                updatedAt:
                  now(),
              },
            },
          );

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res.json({
          user:
            publicUser(
              user,
            ),

          driver:
            driver
              ? {
                  id:
                    String(
                      driver._id,
                    ),

                  approvalStatus:
                    driver.approvalStatus,

                  onlineStatus:
                    driver.onlineStatus,

                  rating:
                    Number(
                      driver.rating ||
                      0,
                    ),
                }
              : null,

          vehicle:
            vehicle
              ? {
                  id:
                    String(
                      vehicle._id,
                    ),

                  plateNumber:
                    vehicle.plateNumber,

                  brand:
                    vehicle.brand,

                  model:
                    vehicle.model,

                  color:
                    vehicle.color,

                  status:
                    vehicle.status,
                }
              : null,

          ...tokens,
        });
      } catch (error) {
        console.error(
          '[AUTH LOGIN]',
          error,
        );

        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );


  // ============================================
  // GENERIC PHONE OTP (non-breaking v1.7.1)
  // ============================================

  router.post('/otp/request', async (req, res) => {
    try {
      const db = getDb();
      const phone = normalizePhone(req.body?.phone);
      const purpose = String(req.body?.purpose || 'PHONE_VERIFY').trim().toUpperCase();
      const allowed = new Set([
        'PHONE_VERIFY',
        'CUSTOMER_PHONE_VERIFY',
        'MERCHANT_PHONE_VERIFY',
        'PASSWORD_RESET',
      ]);
      if (!validatePhone(phone)) {
        return res.status(400).json({ message: 'Số điện thoại không hợp lệ.' });
      }
      if (!allowed.has(purpose)) {
        return res.status(400).json({ message: 'Mục đích OTP không hợp lệ.' });
      }
      if (['PHONE_VERIFY', 'CUSTOMER_PHONE_VERIFY', 'MERCHANT_PHONE_VERIFY'].includes(purpose) &&
          !(await getAppFeatureSettings(db)).otpVerificationEnabled) {
        return res.status(409).json({ code: 'OTP_DISABLED', message: 'OTP đăng ký đã được tắt. Vui lòng đăng ký trực tiếp.' });
      }
      await assertOtpThrottle(db, { phone, purpose });
      const otp = generateOtp();
      const createdAt = now();
      const expiresAt = new Date(Date.now() + OTP_MINUTES * 60 * 1000);
      await db.collection('otp_verifications').insertOne({
        phone,
        purpose,
        codeHash: sha256(otp),
        createdAt,
        expiresAt,
        usedAt: null,
      });
      const delivery = await sendOtpSms({ phone, otp, purpose });
      const response = {
        ok: true,
        delivered: Boolean(delivery?.delivered),
        message: `OTP có hiệu lực ${OTP_MINUTES} phút.`,
        expiresAt: expiresAt.toISOString(),
      };
      if (DEV_SHOW_OTP) response.devOtp = otp;
      return res.json(response);
    } catch (error) {
      if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      return res.status(Number(error?.httpStatus) || 503).json({ message: error.message });
    }
  });

  router.post('/otp/verify', async (req, res) => {
    try {
      const db = getDb();
      const phone = normalizePhone(req.body?.phone);
      const purpose = String(req.body?.purpose || 'PHONE_VERIFY').trim().toUpperCase();
      const code = String(req.body?.otpCode || '').trim();
      if (!validatePhone(phone) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: 'OTP hoặc số điện thoại không hợp lệ.' });
      }
      const record = await db.collection('otp_verifications').findOne({
        phone,
        purpose,
        codeHash: sha256(code),
        usedAt: null,
        expiresAt: { $gt: now() },
      }, { sort: { createdAt: -1 } });
      if (!record) return res.status(400).json({ message: 'OTP không đúng hoặc đã hết hạn.' });
      await db.collection('otp_verifications').updateOne(
        { _id: record._id, usedAt: null },
        { $set: { usedAt: now() } },
      );
      ensureSecret();
      const verificationToken = jwt.sign(
        { phone, purpose, kind: 'OTP_VERIFICATION' },
        JWT_ACCESS_SECRET,
        {
          issuer: 'th79-imove',
          audience: 'th79-imove-apps',
          expiresIn: 10 * 60,
        },
      );
      return res.json({ ok: true, phone, purpose, verificationToken, expiresIn: 600 });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  // ============================================
  // DRIVER REQUEST OTP
  // ============================================

  router.post(
    '/driver/request-otp',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();
        if (!(await getAppFeatureSettings(db)).otpVerificationEnabled) {
          return res.status(409).json({ code: 'OTP_DISABLED', message: 'OTP đăng ký tài xế đã tắt. Vui lòng đăng ký trực tiếp.' });
        }

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        if (
          !validatePhone(
            phone,
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                'Số điện thoại không hợp lệ.',
            });
        }

        const user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        if (
          user &&
          user.passwordHash &&
          Array.isArray(
            user.roles,
          ) &&
          user.roles.includes(
            'DRIVER',
          )
        ) {
          return res
            .status(409)
            .json({
              message:
                'Tài khoản tài xế này đã được đăng ký.',
            });
        }

        await assertOtpThrottle(db, { phone, purpose: 'DRIVER_REGISTER' });

        const otp =
          generateOtp();

        const createdAt =
          now();

        const expiresAt =
          new Date(
            Date.now() +
            OTP_MINUTES *
            60 *
            1000,
          );

        await db
          .collection(
            'otp_verifications',
          )
          .insertOne({
            phone,

            purpose:
              'DRIVER_REGISTER',

            codeHash:
              sha256(
                otp,
              ),

            createdAt,

            expiresAt,

            usedAt:
              null,
          });

        const delivery = await sendOtpSms({
          phone,
          otp,
          purpose: 'DRIVER_REGISTER',
        });

        const response = {
          ok: true,
          delivered: Boolean(delivery?.delivered),

          message:
            `OTP có hiệu lực ${OTP_MINUTES} phút.`,

          expiresAt:
            expiresAt.toISOString(),
        };

        // Chỉ dùng lúc DEV.
        // Production phải gửi OTP qua SMS.
        if (
          DEV_SHOW_OTP
        ) {
          response.devOtp =
            otp;
        }

        return res.json(
          response,
        );
      } catch (error) {
        if (error?.retryAfter) {
          res.setHeader('Retry-After', String(error.retryAfter));
        }
        return res
          .status(Number(error?.httpStatus) || 503)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // DRIVER REGISTER WITH OTP
  // ============================================

  router.post(
    '/driver/register',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const fullName =
          String(
            req.body
              ?.fullName ||
            '',
          ).trim();

        const phone =
          normalizePhone(
            req.body
              ?.phone,
          );

        const email =
          normalizeEmail(
            req.body
              ?.email,
          );

        const password =
          String(
            req.body
              ?.password ||
            '',
          );

        const otpCode =
          String(
            req.body
              ?.otpCode ||
            '',
          ).trim();

        const vehicleType = String(req.body?.vehicleType || 'MOTORBIKE').trim().toUpperCase();
        const requestedServiceCodes = Array.isArray(req.body?.requestedServiceCodes)
          ? [...new Set(req.body.requestedServiceCodes.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))]
          : [];
        const allowedVehicleTypes = new Set(['MOTORBIKE','CAR_4','CAR_7','MPV_7','LUXURY','VAN','TRUCK']);
        const motorbikeServices = new Set(['BIKE','FOOD','ERRAND','DELIVERY']);
        if (!allowedVehicleTypes.has(vehicleType)) {
          return res.status(400).json({ message: 'Loại phương tiện không hợp lệ.' });
        }
        if (vehicleType === 'MOTORBIKE') {
          const invalid = requestedServiceCodes.find((code) => !motorbikeServices.has(code));
          if (invalid || requestedServiceCodes.length === 0) {
            return res.status(400).json({ message: 'Xe máy phải chọn ít nhất một dịch vụ BIKE/FOOD/MARKET/DELIVERY.' });
          }
        }

        const requireOtp = (await getAppFeatureSettings(db)).otpVerificationEnabled;
        if (
          fullName.length < 2 ||
          !validatePhone(phone) ||
          password.length < 6 ||
          (requireOtp && !/^\d{6}$/.test(otpCode))
        ) {
          return res
            .status(400)
            .json({
              message:
                'Thông tin đăng ký tài xế không hợp lệ.',
            });
        }

        const otp = requireOtp
          ? await db.collection('otp_verifications').findOne({
              phone,
              purpose: 'DRIVER_REGISTER',
              codeHash: sha256(otpCode),
              usedAt: null,
              cancelledAt: { $exists: false },
              bypassedBecauseOtpDisabled: { $ne: true },
              expiresAt: { $gt: now() },
            }, { sort: { createdAt: -1 } })
          : null;

        if (requireOtp && !otp) {
          return res
            .status(400)
            .json({
              message:
                'OTP không đúng hoặc đã hết hạn.',
            });
        }

        let user =
          await db
            .collection('users')
            .findOne({
              phone,
            });

        if (
          user &&
          user.passwordHash
        ) {
          return res
            .status(409)
            .json({
              message:
                'Số điện thoại này đã có tài khoản.',
            });
        }

        const passwordHash =
          await bcrypt.hash(
            password,
            12,
          );

        const changedAt =
          now();

        if (user) {
          await db
            .collection('users')
            .updateOne(
              {
                _id:
                  user._id,
              },
              {
                $set: {
                  fullName,
                  email,
                  passwordHash,

                  status:
                    'ACTIVE',

                  updatedAt:
                    changedAt,
                },

                $addToSet: {
                  roles:
                    'DRIVER',
                },
              },
            );

          user =
            await db
              .collection('users')
              .findOne({
                _id:
                  user._id,
              });
        } else {
          const doc = {
            phone,
            fullName,
            email,

            passwordHash,

            avatarUrl:
              null,

            status:
              'ACTIVE',

            roles: [
              'DRIVER',
            ],

            lastLoginAt:
              null,

            createdAt:
              changedAt,

            updatedAt:
              changedAt,
          };

          const result =
            await db
              .collection('users')
              .insertOne(
                doc,
              );

          user = {
            ...doc,

            _id:
              result.insertedId,
          };
        }

        let driver =
          await db
            .collection('drivers')
            .findOne({
              userId:
                user._id,
            });

        // Driver Demo đã có driver APPROVED:
        // giữ nguyên.
        // Driver mới => PENDING.
        if (!driver) {
          const driverDoc = {
            userId:
              user._id,

            approvalStatus:
              'PENDING',

            // Keep the initial driver record consistent with the KYC flow.
            // Without this field, accounts created from the app looked unlike
            // accounts created by the back-office tools until their first KYC
            // update, which made operations screens harder to reason about.
            kycStatus:
              'INCOMPLETE',

            onlineStatus:
              'OFFLINE',

            vehicleType,
            requestedServiceCodes,
            approvedServiceCodes: [],
            serviceCapabilities: [],
            servicePreferences: Object.fromEntries(
              requestedServiceCodes.map((code) => [code, false]),
            ),

            rating:
              5,

            completedTrips:
              0,

            cancelledTrips:
              0,

            acceptanceRate:
              100,

            approvedAt:
              null,

            createdAt:
              changedAt,

            updatedAt:
              changedAt,
          };

          const result =
            await db
              .collection('drivers')
              .insertOne(
                driverDoc,
              );

          driver = {
            ...driverDoc,

            _id:
              result.insertedId,
          };
        }

        if (otp) {
          await db.collection('otp_verifications').updateOne(
            { _id: otp._id, usedAt: null },
            { $set: { usedAt: changedAt } },
          );
        }

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res
          .status(201)
          .json({
            user:
              publicUser(
                user,
              ),

            driver: {
              id:
                String(
                  driver._id,
                ),

              approvalStatus:
                driver.approvalStatus,

              onlineStatus:
                driver.onlineStatus,

              rating:
                Number(
                  driver.rating ||
                  0,
                ),
            },

            ...tokens,
          });
      } catch (error) {
        console.error(
          '[DRIVER REGISTER]',
          error,
        );

        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // REFRESH TOKEN
  // ============================================

  router.post(
    '/refresh',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const refreshToken =
          String(
            req.body
              ?.refreshToken ||
            '',
          );

        if (
          refreshToken.length < 40
        ) {
          return res
            .status(401)
            .json({
              message:
                'Refresh Token không hợp lệ.',
            });
        }

        const tokenHash =
          sha256(
            refreshToken,
          );

        const session =
          await db
            .collection(
              'auth_sessions',
            )
            .findOne({
              tokenHash,

              revokedAt:
                null,

              expiresAt: {
                $gt:
                  now(),
              },
            });

        if (!session) {
          return res
            .status(401)
            .json({
              message:
                'Phiên đăng nhập đã hết hạn.',
            });
        }

        const user =
          await db
            .collection('users')
            .findOne({
              _id:
                session.userId,

              status:
                'ACTIVE',
            });

        if (!user) {
          return res
            .status(401)
            .json({
              message:
                'Tài khoản không còn hoạt động.',
            });
        }

        // Rotate refresh token:
        // token cũ không dùng lại được.
        await db
          .collection(
            'auth_sessions',
          )
          .updateOne(
            {
              _id:
                session._id,
            },
            {
              $set: {
                revokedAt:
                  now(),

                revokeReason:
                  'ROTATED',
              },
            },
          );

        const tokens =
          await issueTokens({
            db,
            user,
            req,
          });

        return res.json({
          user:
            publicUser(
              user,
            ),

          ...tokens,
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  // ============================================
  // ME
  // ============================================

  router.get(
    '/me',
    authenticate,
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const user =
          req.auth.user;

        let driver = null;

        if (
          Array.isArray(
            user.roles,
          ) &&
          user.roles.includes(
            'DRIVER',
          )
        ) {
          driver =
            await db
              .collection('drivers')
              .findOne({
                userId:
                  user._id,
              });
        }

        return res.json({
          user:
            publicUser(
              user,
            ),

          driver:
            driver
              ? {
                  id:
                    String(
                      driver._id,
                    ),

                  approvalStatus:
                    driver.approvalStatus,

                  onlineStatus:
                    driver.onlineStatus,

                  rating:
                    Number(
                      driver.rating ||
                      0,
                    ),
                }
              : null,
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );


  // Profile updates require a live customer JWT. Phone remains immutable here:
  // changing phone must go through a separate re-verification/OTP flow.
  router.patch('/me', authenticate, async (req, res) => {
    try {
      if (!req.auth.user.roles?.includes('CUSTOMER')) {
        return res.status(403).json({ message: 'Chỉ tài khoản khách hàng được chỉnh sửa hồ sơ tại đây.' });
      }
      const fullName = String(req.body?.fullName ?? '').trim().replace(/\s+/g, ' ');
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (fullName.length < 2 || fullName.length > 80 || /[\x00-\x1F\x7F]/.test(fullName)) {
        return res.status(400).json({ message: 'Họ và tên phải có từ 2 đến 80 ký tự hợp lệ.' });
      }
      if (email.length > 150 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        return res.status(400).json({ message: 'Địa chỉ email không hợp lệ.' });
      }
      const db = getDb();
      await db.collection('users').updateOne(
        { _id: req.auth.user._id, status: 'ACTIVE' },
        { $set: { fullName, email: email || null, updatedAt: new Date() } },
      );
      const user = await db.collection('users').findOne({ _id: req.auth.user._id });
      return res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
      return res.status(500).json({ message: 'Không lưu được thông tin tài khoản.' });
    }
  });

  const avatarBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2mb' });
  router.put('/me/avatar', authenticate, avatarBody, async (req, res) => {
    if (!req.auth.user.roles?.includes('CUSTOMER')) {
      return res.status(403).json({ message: 'Không có quyền thay avatar này.' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length || data.length > 2 * 1024 * 1024) {
      return res.status(400).json({ message: 'Ảnh đại diện phải là PNG/JPEG/WebP, tối đa 2 MB.' });
    }
    const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const webp = data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (!((mime === 'image/png' && png) || (mime === 'image/jpeg' && jpeg) || (mime === 'image/webp' && webp))) {
      return res.status(415).json({ message: 'Định dạng hoặc dữ liệu ảnh không hợp lệ.' });
    }
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'user_avatars' });
    const previous = req.auth.user.avatarFileId;
    let uploadedId;
    try {
      const file = bucket.openUploadStream(`user_${req.auth.user._id}_${Date.now()}`, {
        contentType: mime,
        metadata: { userId: req.auth.user._id, purpose: 'CUSTOMER_AVATAR' },
      });
      uploadedId = file.id;
      await new Promise((resolve, reject) => {
        file.on('finish', resolve);
        file.on('error', reject);
        file.end(data);
      });
      const avatarUrl = `/api/auth/avatars/${req.auth.user._id}?v=${Date.now()}`;
      await db.collection('users').updateOne(
        { _id: req.auth.user._id, status: 'ACTIVE' },
        { $set: { avatarFileId: uploadedId, avatarUrl, updatedAt: new Date() } },
      );
      if (previous) {
        try { await bucket.delete(previous); } catch (_) { /* best effort cleanup */ }
      }
      const user = await db.collection('users').findOne({ _id: req.auth.user._id });
      return res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
      if (uploadedId) {
        try { await bucket.delete(uploadedId); } catch (_) { /* ignore */ }
      }
      return res.status(500).json({ message: 'Không thể lưu ảnh đại diện lên máy chủ.' });
    }
  });

  // Public image endpoint; serves only the avatar currently attached to a user.
  router.get('/avatars/:userId', async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.userId)) return res.sendStatus(404);
      const db = getDb();
      const user = await db.collection('users').findOne(
        { _id: new ObjectId(req.params.userId), avatarFileId: { $exists: true } },
        { projection: { avatarFileId: 1 } },
      );
      if (!user?.avatarFileId) return res.sendStatus(404);
      const file = await db.collection('user_avatars.files').findOne({ _id: user.avatarFileId });
      if (!file) return res.sendStatus(404);
      const contentType = file.contentType || 'application/octet-stream';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=300');
      const stream = new GridFSBucket(db, { bucketName: 'user_avatars' }).openDownloadStream(file._id);
      stream.on('error', () => { if (!res.headersSent) res.sendStatus(404); else res.destroy(); });
      return stream.pipe(res);
    } catch (_) {
      if (!res.headersSent) return res.sendStatus(404);
      return res.end();
    }
  });

  // ============================================
  // LOGOUT
  // ============================================

  router.post(
    '/logout',
    async (
      req,
      res,
    ) => {
      try {
        const db =
          getDb();

        const refreshToken =
          String(
            req.body
              ?.refreshToken ||
            '',
          );

        if (
          refreshToken
        ) {
          await db
            .collection(
              'auth_sessions',
            )
            .updateOne(
              {
                tokenHash:
                  sha256(
                    refreshToken,
                  ),

                revokedAt:
                  null,
              },
              {
                $set: {
                  revokedAt:
                    now(),

                  revokeReason:
                    'LOGOUT',
                },
              },
            );
        }

        return res.json({
          ok: true,

          message:
            'Đã đăng xuất.',
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            message:
              error.message,
          });
      }
    },
  );

  return router;
}

module.exports = {
  createAuthRouter,
  createAuthenticate,
  publicUser,
};

