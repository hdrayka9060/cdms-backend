// What does Mongoose think the schema type is for Lead.vehicle vs Vehicle.addedBy?
process.env.NODE_ENV = 'test';

(async () => {
  // Compile the project's schema files via ts-node so we see the real metadata.
  require('ts-node/register/transpile-only');
  const { LeadSchema } = require('./src/modules/leads/schemas/lead.schema');
  const { VehicleSchema } = require('./src/modules/inventory/schemas/vehicle.schema');

  const show = (label, schema, path) => {
    const t = schema.path(path);
    console.log(`${label}.${path}: instance=${t?.instance}  ctor=${t?.constructor?.name}  options=`, t?.options);
  };

  show('Lead', LeadSchema, 'vehicle');
  show('Lead', LeadSchema, 'buyer');
  show('Vehicle', VehicleSchema, 'addedBy');
  show('Vehicle', VehicleSchema, 'seller');
})().catch(e => { console.error(e); process.exit(1); });
