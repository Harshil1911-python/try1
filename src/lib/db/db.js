import Dexie from 'dexie';

export const db = new Dexie('TechSereniaPOS');

db.version(1).stores({
  products: '++id, name, barcode, category, price, cost, stock, image, gstRate, active, createdAt, updatedAt',
  heldBills: '++id, billNumber, items, subtotal, tax, discount, total, customerName, createdAt, note',
  transactions: '++id, invoiceNumber, items, subtotal, tax, discount, total, paymentMode, customerName, createdAt, status',
  settings: 'key, value'
});

// Seed default settings and a few sample products on first run
export async function initDb() {
  const count = await db.products.count();
  if (count === 0) {
    const now = new Date().toISOString();
    await db.products.bulkAdd([
      {
        name: 'Sample Product 1',
        barcode: '1001',
        category: 'General',
        price: 99,
        cost: 60,
        stock: 50,
        image: null,
        gstRate: 18,
        active: true,
        createdAt: now,
        updatedAt: now
      },
      {
        name: 'Sample Product 2',
        barcode: '1002',
        category: 'General',
        price: 149,
        cost: 90,
        stock: 30,
        image: null,
        gstRate: 18,
        active: true,
        createdAt: now,
        updatedAt: now
      },
      {
        name: 'Sample Product 3',
        barcode: '1003',
        category: 'Electronics',
        price: 499,
        cost: 350,
        stock: 15,
        image: null,
        gstRate: 18,
        active: true,
        createdAt: now,
        updatedAt: now
      }
    ]);
  }

  const settingsCount = await db.settings.count();
  if (settingsCount === 0) {
    await db.settings.bulkAdd([
      { key: 'shopName', value: 'TechSerenia POS' },
      { key: 'gstin', value: '' },
      { key: 'invoicePrefix', value: 'TS' },
      { key: 'currency', value: '₹' }
    ]);
  }
}

export async function getNextInvoiceNumber() {
  const prefix = (await db.settings.get('invoicePrefix'))?.value || 'TS';
  const last = await db.transactions.orderBy('id').last();
  const nextNum = last ? last.id + 1 : 1;
  return `${prefix}-${String(nextNum).padStart(5, '0')}`;
}
