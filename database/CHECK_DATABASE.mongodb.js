const DB_NAME = process.env.IMOVE_DB_NAME || 'th79_imove';
const d = db.getSiblingDB(DB_NAME);
print(`Database: ${DB_NAME}`);
print(`Collections (${d.getCollectionNames().length}):`);
for (const name of d.getCollectionNames().sort()) {
  print(`  ${name}: ${d.getCollection(name).countDocuments({})}`);
}
print('');
print('Active BIKE fare:');
printjson(d.fare_configs.findOne({ serviceCode: 'BIKE', areaCode: 'GLOBAL', status: 'ACTIVE' }, { _id: 0 }));
print('');
print('Active BIKE platform fee:');
printjson(d.platform_fees.findOne({ serviceCode: 'BIKE', areaCode: 'GLOBAL', status: 'ACTIVE' }, { _id: 0 }));
