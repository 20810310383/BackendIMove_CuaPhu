function numberValue(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(numberValue(value));
}

function roundUp(value, unit) {
  const amount = roundMoney(value);
  const roundingUnit = Math.max(1, roundMoney(unit));
  if (roundingUnit <= 1) return amount;
  const remainder = amount % roundingUnit;
  return remainder === 0 ? amount : amount + (roundingUnit - remainder);
}

async function findActiveVersion({ db, collectionName, serviceCode, areaCode }) {
  const now = new Date();
  const effective = {
    serviceCode,
    status: 'ACTIVE',
    $and: [
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $exists: false } }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gt: now } }] },
    ],
  };

  let config = await db.collection(collectionName).findOne(
    { ...effective, areaCode },
    { sort: { version: -1 } },
  );

  if (!config && areaCode !== 'GLOBAL') {
    config = await db.collection(collectionName).findOne(
      { ...effective, areaCode: 'GLOBAL' },
      { sort: { version: -1 } },
    );
  }
  return config;
}

async function getActiveSurcharges({ db, serviceCode, areaCode }) {
  return db.collection('surcharges').find({
    serviceCode,
    status: 'ACTIVE',
    $or: [
      { areaCodes: areaCode },
      { areaCodes: 'GLOBAL' },
      { areaCodes: { $exists: false } },
    ],
  }).sort({ code: 1 }).toArray();
}

function calculateDistanceFare(distanceKm, tiers) {
  let amount = 0;
  const sorted = [...tiers].sort((a, b) => numberValue(a.fromKm) - numberValue(b.fromKm));
  for (const tier of sorted) {
    const fromKm = numberValue(tier.fromKm);
    const toKm = tier.toKm === null || tier.toKm === undefined ? distanceKm : numberValue(tier.toKm);
    const pricePerKm = numberValue(tier.pricePerKm);
    if (distanceKm <= fromKm) continue;
    const chargeTo = Math.min(distanceKm, toKm);
    const chargeKm = chargeTo - fromKm;
    if (chargeKm > 0) amount += chargeKm * pricePerKm;
  }
  return roundMoney(amount);
}

function surchargeAmount(surcharge, tripFare) {
  const type = String(surcharge.calculationType || 'FIXED').toUpperCase();
  const value = numberValue(surcharge.value);
  if (type === 'PERCENT') return roundMoney(tripFare * value / 100);
  if (type === 'MULTIPLIER') return value > 1 ? roundMoney(tripFare * (value - 1)) : 0;
  return roundMoney(value);
}

async function calculateFare({ db, serviceCode = 'BIKE', areaCode = 'GLOBAL', distanceKm, durationMinutes }) {
  const service = String(serviceCode || 'BIKE').trim().toUpperCase();
  const area = String(areaCode || 'GLOBAL').trim().toUpperCase();
  const distance = numberValue(distanceKm);
  const duration = Math.max(0, Math.round(numberValue(durationMinutes)));

  if (distance <= 0) throw new Error('Quãng đường phải lớn hơn 0 km.');

  const fare = await findActiveVersion({ db, collectionName: 'fare_configs', serviceCode: service, areaCode: area });
  if (!fare) throw new Error(`Không tìm thấy bảng giá ACTIVE cho ${service}.`);

  const fees = await findActiveVersion({ db, collectionName: 'platform_fees', serviceCode: service, areaCode: area });
  if (!fees) throw new Error(`Không tìm thấy cấu hình phí ACTIVE cho ${service}.`);

  const baseFare = roundMoney(fare.baseFare);
  const minimumFare = roundMoney(fare.minimumFare);
  const pricePerMinute = roundMoney(fare.pricePerMinute);
  const roundingUnit = Math.max(1, roundMoney(fare.roundingUnit || 1));
  const distanceFare = calculateDistanceFare(distance, Array.isArray(fare.distanceTiers) ? fare.distanceTiers : []);
  const timeFare = roundMoney(duration * pricePerMinute);
  const tripFare = Math.max(minimumFare, baseFare + distanceFare + timeFare);

  const surchargeConfigs = await getActiveSurcharges({ db, serviceCode: service, areaCode: area });
  const surcharges = [];
  let surchargeTotal = 0;
  for (const item of surchargeConfigs) {
    const amount = surchargeAmount(item, tripFare);
    if (amount <= 0) continue;
    surchargeTotal += amount;
    surcharges.push({
      code: item.code,
      name: item.name,
      calculationType: item.calculationType,
      value: numberValue(item.value),
      amount,
    });
  }
  surchargeTotal = roundMoney(surchargeTotal);

  const driverGrossAmount = tripFare + surchargeTotal;
  const bookingFee = roundMoney(fees.bookingFee);
  const customerServiceFee = roundMoney(fees.customerServiceFee);
  const driverFixedFee = roundMoney(fees.driverFixedFee);
  const paymentFeePercent = numberValue(fees.paymentFeePercent);
  const paymentFeeBase = driverGrossAmount + bookingFee + customerServiceFee;
  const paymentFee = roundMoney(paymentFeeBase * paymentFeePercent / 100);
  const customerTotal = roundUp(paymentFeeBase + paymentFee, roundingUnit);

  const commission = fees.driverCommission || { type: 'PERCENT', value: 0 };
  const commissionType = String(commission.type || 'PERCENT').toUpperCase();
  const commissionValue = numberValue(commission.value);
  const platformCommission = commissionType === 'FIXED'
    ? roundMoney(commissionValue)
    : roundMoney(driverGrossAmount * commissionValue / 100);
  const driverNetAmount = Math.max(0, driverGrossAmount - platformCommission - driverFixedFee);

  return {
    serviceCode: service,
    areaCode: area,
    currency: fare.currency || 'VND',
    distanceKm: Number(distance.toFixed(3)),
    durationMinutes: duration,
    baseFare,
    distanceFare,
    timeFare,
    minimumFare,
    tripFare,
    surchargeTotal,
    surcharges,
    driverGrossAmount,
    bookingFee,
    customerServiceFee,
    paymentFeePercent,
    paymentFee,
    customerTotal,
    driverCommissionType: commissionType,
    driverCommissionPercent: commissionType === 'PERCENT' ? commissionValue : 0,
    driverCommissionValue: commissionValue,
    platformCommission,
    driverFixedFee,
    driverNetAmount,
    platformRevenueEstimate: bookingFee + customerServiceFee + paymentFee + platformCommission + driverFixedFee,
    roundingUnit,
    fareConfigVersion: numberValue(fare.version),
    platformFeeVersion: numberValue(fees.version),
    fareConfigId: String(fare._id),
    platformFeeId: String(fees._id),
    calculatedAt: new Date(),
  };
}

module.exports = { calculateFare };
