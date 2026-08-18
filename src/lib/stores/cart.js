import { writable, derived } from 'svelte/store';

function createCart() {
  const { subscribe, set, update } = writable([]);

  return {
    subscribe,
    add(product, qty = 1) {
      update(items => {
        const idx = items.findIndex(i => i.productId === product.id);
        if (idx >= 0) {
          const copy = [...items];
          copy[idx] = { ...copy[idx], qty: copy[idx].qty + qty };
          return copy;
        }
        return [...items, {
          productId: product.id,
          name: product.name,
          price: product.price,
          gstRate: product.gstRate || 0,
          qty,
          image: product.image
        }];
      });
    },
    setQty(productId, qty) {
      update(items => {
        if (qty <= 0) return items.filter(i => i.productId !== productId);
        return items.map(i => i.productId === productId ? { ...i, qty } : i);
      });
    },
    remove(productId) {
      update(items => items.filter(i => i.productId !== productId));
    },
    clear() {
      set([]);
    },
    load(items) {
      set(items || []);
    }
  };
}

export const cart = createCart();

export const cartTotals = derived(cart, $cart => {
  let subtotal = 0;
  let tax = 0;
  for (const item of $cart) {
    const line = item.price * item.qty;
    subtotal += line;
    tax += line * (item.gstRate / 100);
  }
  const discount = 0;
  const total = subtotal + tax - discount;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    discount,
    total: Math.round(total * 100) / 100,
    itemCount: $cart.reduce((s, i) => s + i.qty, 0)
  };
});
