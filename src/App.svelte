<script>
  import { onMount } from 'svelte';
  import { db, initDb, getNextInvoiceNumber } from './lib/db/db.js';
  import { cart, cartTotals } from './lib/stores/cart.js';
  import { liveQuery } from 'dexie';

  // Modes: 'billing' | 'admin'
  let mode = $state('billing');
  // Billing sub: 'photo' | 'text' | 'held' | 'transactions' | 'calculator'
  let billingTab = $state('text');
  // Admin sub
  let adminTab = $state('products');

  let products = $state([]);
  let heldBills = $state([]);
  let transactions = $state([]);
  let searchQuery = $state('');
  let showProductForm = $state(false);
  let editingProduct = $state(null);
  let form = $state({
    name: '', barcode: '', category: 'General', price: 0, cost: 0, stock: 0, gstRate: 18, image: null, active: true
  });
  let calcDisplay = $state('0');
  let calcPrev = $state(null);
  let calcOp = $state(null);
  let calcFresh = $state(true);
  let toast = $state('');
  let paymentMode = $state('Cash');
  let customerName = $state('');
  let discountAmount = $state(0);

  onMount(async () => {
    await initDb();
    // Live queries
    const unsubProducts = liveQuery(() => db.products.orderBy('name').toArray()).subscribe(p => {
      products = p || [];
    });
    const unsubHeld = liveQuery(() => db.heldBills.orderBy('createdAt').reverse().toArray()).subscribe(h => {
      heldBills = h || [];
    });
    const unsubTx = liveQuery(() => db.transactions.orderBy('createdAt').reverse().limit(100).toArray()).subscribe(t => {
      transactions = t || [];
    });
    return () => {
      unsubProducts.unsubscribe();
      unsubHeld.unsubscribe();
      unsubTx.unsubscribe();
    };
  });

  function showToast(msg) {
    toast = msg;
    setTimeout(() => toast = '', 2500);
  }

  // --- Product CRUD ---
  function openAddProduct() {
    editingProduct = null;
    form = { name: '', barcode: '', category: 'General', price: 0, cost: 0, stock: 0, gstRate: 18, image: null, active: true };
    showProductForm = true;
  }

  function openEditProduct(p) {
    editingProduct = p;
    form = {
      name: p.name,
      barcode: p.barcode || '',
      category: p.category || 'General',
      price: p.price,
      cost: p.cost || 0,
      stock: p.stock || 0,
      gstRate: p.gstRate || 18,
      image: p.image || null,
      active: p.active !== false
    };
    showProductForm = true;
  }

  async function saveProduct() {
    if (!form.name.trim()) {
      showToast('Product name required');
      return;
    }
    const now = new Date().toISOString();
    const data = {
      name: form.name.trim(),
      barcode: form.barcode.trim(),
      category: form.category.trim() || 'General',
      price: Number(form.price) || 0,
      cost: Number(form.cost) || 0,
      stock: Number(form.stock) || 0,
      gstRate: Number(form.gstRate) || 0,
      image: form.image,
      active: form.active,
      updatedAt: now
    };
    if (editingProduct) {
      await db.products.update(editingProduct.id, data);
      showToast('Product updated');
    } else {
      data.createdAt = now;
      await db.products.add(data);
      showToast('Product added');
    }
    showProductForm = false;
  }

  async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    await db.products.delete(id);
    showToast('Product deleted');
  }

  function handleImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      form.image = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // --- Cart / Billing ---
  function addToCart(p) {
    if (!p.active) {
      showToast('Product inactive');
      return;
    }
    cart.add(p, 1);
    showToast(`Added ${p.name}`);
  }

  async function holdBill() {
    const items = $cart;
    if (!items.length) {
      showToast('Cart is empty');
      return;
    }
    const totals = $cartTotals;
    const billNumber = `H-${Date.now().toString().slice(-6)}`;
    await db.heldBills.add({
      billNumber,
      items: JSON.parse(JSON.stringify(items)),
      subtotal: totals.subtotal,
      tax: totals.tax,
      discount: discountAmount,
      total: totals.total - discountAmount,
      customerName: customerName || '',
      createdAt: new Date().toISOString(),
      note: ''
    });
    cart.clear();
    customerName = '';
    discountAmount = 0;
    showToast('Bill held: ' + billNumber);
    billingTab = 'held';
  }

  async function restoreHeld(bill) {
    cart.load(bill.items);
    customerName = bill.customerName || '';
    discountAmount = bill.discount || 0;
    await db.heldBills.delete(bill.id);
    billingTab = 'text';
    showToast('Held bill restored');
  }

  async function deleteHeld(id) {
    if (!confirm('Delete held bill?')) return;
    await db.heldBills.delete(id);
    showToast('Held bill deleted');
  }

  async function completeSale() {
    const items = $cart;
    if (!items.length) {
      showToast('Cart is empty');
      return;
    }
    const totals = $cartTotals;
    const finalTotal = Math.max(0, totals.total - (discountAmount || 0));
    const invoiceNumber = await getNextInvoiceNumber();
    await db.transactions.add({
      invoiceNumber,
      items: JSON.parse(JSON.stringify(items)),
      subtotal: totals.subtotal,
      tax: totals.tax,
      discount: discountAmount || 0,
      total: finalTotal,
      paymentMode,
      customerName: customerName || '',
      createdAt: new Date().toISOString(),
      status: 'completed'
    });
    // Deduct stock
    for (const item of items) {
      const p = await db.products.get(item.productId);
      if (p) {
        await db.products.update(item.productId, {
          stock: Math.max(0, (p.stock || 0) - item.qty),
          updatedAt: new Date().toISOString()
        });
      }
    }
    cart.clear();
    customerName = '';
    discountAmount = 0;
    showToast(`Sale complete: ${invoiceNumber}`);
    billingTab = 'transactions';
  }

  // Filtered products for Text POS (only when searched)
  let filteredProducts = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return products.filter(p =>
      p.active !== false &&
      (p.name.toLowerCase().includes(q) ||
       (p.barcode || '').toLowerCase().includes(q) ||
       (p.category || '').toLowerCase().includes(q))
    );
  });

  // Photo POS: all active products
  let photoProducts = $derived(products.filter(p => p.active !== false));

  // Calculator
  function calcInput(val) {
    if (calcFresh) {
      calcDisplay = String(val);
      calcFresh = false;
    } else {
      if (calcDisplay === '0' && val !== '.') calcDisplay = String(val);
      else calcDisplay += String(val);
    }
  }
  function calcClear() {
    calcDisplay = '0';
    calcPrev = null;
    calcOp = null;
    calcFresh = true;
  }
  function calcOperator(op) {
    if (calcOp && !calcFresh) {
      calcEquals();
    }
    calcPrev = parseFloat(calcDisplay);
    calcOp = op;
    calcFresh = true;
  }
  function calcEquals() {
    if (calcOp == null || calcPrev == null) return;
    const curr = parseFloat(calcDisplay);
    let result = curr;
    if (calcOp === '+') result = calcPrev + curr;
    else if (calcOp === '-') result = calcPrev - curr;
    else if (calcOp === '×') result = calcPrev * curr;
    else if (calcOp === '÷') result = curr === 0 ? 0 : calcPrev / curr;
    calcDisplay = String(Math.round(result * 1000000) / 1000000);
    calcOp = null;
    calcPrev = null;
    calcFresh = true;
  }
  function calcPercent() {
    calcDisplay = String(parseFloat(calcDisplay) / 100);
  }

  function formatMoney(n) {
    return '₹' + (Number(n) || 0).toFixed(2);
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="app">
  <!-- Top bar with logo -->
  <header class="topbar">
    <div class="logo-area">
      <img src="/logo.png" alt="TechSerenia" class="logo" onerror={(e) => e.currentTarget.style.display = 'none'} />
      <div class="brand">
        <span class="brand-name">TechSerenia</span>
        <span class="brand-sub">POS</span>
      </div>
    </div>
    <nav class="mode-nav">
      <button class:active={mode === 'billing'} onclick={() => mode = 'billing'}>Billing</button>
      <button class:active={mode === 'admin'} onclick={() => mode = 'admin'}>Admin</button>
    </nav>
  </header>

  {#if toast}
    <div class="toast">{toast}</div>
  {/if}

  {#if mode === 'billing'}
    <div class="billing-layout">
      <!-- Left: tabs + content -->
      <div class="billing-main">
        <div class="tabs">
          <button class:active={billingTab === 'photo'} onclick={() => billingTab = 'photo'}>Photo POS</button>
          <button class:active={billingTab === 'text'} onclick={() => billingTab = 'text'}>Text POS</button>
          <button class:active={billingTab === 'held'} onclick={() => billingTab = 'held'}>Held Bills</button>
          <button class:active={billingTab === 'transactions'} onclick={() => billingTab = 'transactions'}>Transactions</button>
          <button class:active={billingTab === 'calculator'} onclick={() => billingTab = 'calculator'}>Calculator</button>
        </div>

        <div class="tab-content">
          {#if billingTab === 'photo'}
            <div class="photo-grid">
              {#each photoProducts as p (p.id)}
                <button class="photo-card" onclick={() => addToCart(p)}>
                  {#if p.image}
                    <img src={p.image} alt={p.name} />
                  {:else}
                    <div class="no-img">{p.name.charAt(0)}</div>
                  {/if}
                  <div class="photo-info">
                    <span class="p-name">{p.name}</span>
                    <span class="p-price">{formatMoney(p.price)}</span>
                  </div>
                </button>
              {:else}
                <p class="empty">No products. Add some in Admin → Products.</p>
              {/each}
            </div>

          {:else if billingTab === 'text'}
            <div class="text-pos">
              <input
                class="search-input"
                type="search"
                placeholder="Search product by name, barcode or category..."
                bind:value={searchQuery}
                autofocus
              />
              {#if searchQuery.trim()}
                <div class="search-results">
                  {#each filteredProducts as p (p.id)}
                    <button class="result-row" onclick={() => addToCart(p)}>
                      <div class="r-left">
                        {#if p.image}
                          <img src={p.image} alt="" class="thumb" />
                        {:else}
                          <div class="thumb-placeholder">{p.name.charAt(0)}</div>
                        {/if}
                        <div>
                          <div class="r-name">{p.name}</div>
                          <div class="r-meta">{p.barcode || '—'} · {p.category} · Stock: {p.stock}</div>
                        </div>
                      </div>
                      <div class="r-price">{formatMoney(p.price)}</div>
                    </button>
                  {:else}
                    <p class="empty">No matching products</p>
                  {/each}
                </div>
              {:else}
                <p class="hint">Type to search products. Products appear only when searched.</p>
              {/if}
            </div>

          {:else if billingTab === 'held'}
            <div class="list-view">
              {#each heldBills as bill (bill.id)}
                <div class="list-card">
                  <div class="list-head">
                    <strong>{bill.billNumber}</strong>
                    <span>{formatDate(bill.createdAt)}</span>
                  </div>
                  <div class="list-body">
                    {bill.items?.length || 0} items · {formatMoney(bill.total)}
                    {#if bill.customerName}<span> · {bill.customerName}</span>{/if}
                  </div>
                  <div class="list-actions">
                    <button class="btn-primary sm" onclick={() => restoreHeld(bill)}>Restore</button>
                    <button class="btn-danger sm" onclick={() => deleteHeld(bill.id)}>Delete</button>
                  </div>
                </div>
              {:else}
                <p class="empty">No held bills</p>
              {/each}
            </div>

          {:else if billingTab === 'transactions'}
            <div class="list-view">
              {#each transactions as tx (tx.id)}
                <div class="list-card">
                  <div class="list-head">
                    <strong>{tx.invoiceNumber}</strong>
                    <span class="badge">{tx.paymentMode}</span>
                  </div>
                  <div class="list-body">
                    {formatDate(tx.createdAt)} · {tx.items?.length || 0} items · {formatMoney(tx.total)}
                    {#if tx.customerName}<span> · {tx.customerName}</span>{/if}
                  </div>
                </div>
              {:else}
                <p class="empty">No transactions yet</p>
              {/each}
            </div>

          {:else if billingTab === 'calculator'}
            <div class="calculator">
              <div class="calc-display">{calcDisplay}</div>
              <div class="calc-keys">
                <button onclick={calcClear}>C</button>
                <button onclick={calcPercent}>%</button>
                <button onclick={() => calcOperator('÷')}>÷</button>
                <button onclick={() => calcOperator('×')}>×</button>
                <button onclick={() => calcInput(7)}>7</button>
                <button onclick={() => calcInput(8)}>8</button>
                <button onclick={() => calcInput(9)}>9</button>
                <button onclick={() => calcOperator('-')}>−</button>
                <button onclick={() => calcInput(4)}>4</button>
                <button onclick={() => calcInput(5)}>5</button>
                <button onclick={() => calcInput(6)}>6</button>
                <button onclick={() => calcOperator('+')}>+</button>
                <button onclick={() => calcInput(1)}>1</button>
                <button onclick={() => calcInput(2)}>2</button>
                <button onclick={() => calcInput(3)}>3</button>
                <button class="equals" onclick={calcEquals}>=</button>
                <button class="zero" onclick={() => calcInput(0)}>0</button>
                <button onclick={() => calcInput('.')}>.</button>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Right: Cart -->
      <aside class="cart-panel">
        <h3>Cart <span class="count">{$cartTotals.itemCount}</span></h3>
        <div class="cart-items">
          {#each $cart as item (item.productId)}
            <div class="cart-row">
              <div class="ci-info">
                <span class="ci-name">{item.name}</span>
                <span class="ci-price">{formatMoney(item.price)} × {item.qty}</span>
              </div>
              <div class="ci-qty">
                <button onclick={() => cart.setQty(item.productId, item.qty - 1)}>−</button>
                <span>{item.qty}</span>
                <button onclick={() => cart.setQty(item.productId, item.qty + 1)}>+</button>
              </div>
              <button class="ci-remove" onclick={() => cart.remove(item.productId)}>×</button>
            </div>
          {:else}
            <p class="empty-cart">Cart is empty</p>
          {/each}
        </div>
        <div class="cart-meta">
          <input type="text" placeholder="Customer name (optional)" bind:value={customerName} />
          <div class="row">
            <label>Discount ₹</label>
            <input type="number" min="0" step="0.01" bind:value={discountAmount} />
          </div>
          <div class="row">
            <label>Payment</label>
            <select bind:value={paymentMode}>
              <option>Cash</option>
              <option>UPI</option>
              <option>Card</option>
              <option>Other</option>
            </select>
          </div>
        </div>
        <div class="cart-totals">
          <div><span>Subtotal</span><span>{formatMoney($cartTotals.subtotal)}</span></div>
          <div><span>GST</span><span>{formatMoney($cartTotals.tax)}</span></div>
          {#if discountAmount > 0}
            <div><span>Discount</span><span>−{formatMoney(discountAmount)}</span></div>
          {/if}
          <div class="grand"><span>Total</span><span>{formatMoney(Math.max(0, $cartTotals.total - (discountAmount || 0)))}</span></div>
        </div>
        <div class="cart-actions">
          <button class="btn-secondary" onclick={holdBill} disabled={$cart.length === 0}>Hold</button>
          <button class="btn-primary" onclick={completeSale} disabled={$cart.length === 0}>Pay</button>
          <button class="btn-ghost" onclick={() => cart.clear()} disabled={$cart.length === 0}>Clear</button>
        </div>
      </aside>
    </div>

  {:else if mode === 'admin'}
    <div class="admin-layout">
      <div class="tabs">
        <button class:active={adminTab === 'products'} onclick={() => adminTab = 'products'}>Products</button>
      </div>
      <div class="admin-content">
        <div class="admin-toolbar">
          <h2>Products</h2>
          <button class="btn-primary" onclick={openAddProduct}>+ Add Product</button>
        </div>
        <div class="product-table-wrap">
          <table class="product-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Barcode</th>
                <th>Category</th>
                <th>Price</th>
                <th>Stock</th>
                <th>GST%</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each products as p (p.id)}
                <tr>
                  <td>
                    {#if p.image}
                      <img src={p.image} alt="" class="tbl-img" />
                    {:else}
                      <div class="tbl-img-ph">{p.name.charAt(0)}</div>
                    {/if}
                  </td>
                  <td>{p.name}</td>
                  <td>{p.barcode || '—'}</td>
                  <td>{p.category}</td>
                  <td>{formatMoney(p.price)}</td>
                  <td>{p.stock}</td>
                  <td>{p.gstRate}%</td>
                  <td>
                    <span class="status" class:off={!p.active}>{p.active !== false ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td class="actions">
                    <button class="btn-ghost sm" onclick={() => openEditProduct(p)}>Edit</button>
                    <button class="btn-danger sm" onclick={() => deleteProduct(p.id)}>Del</button>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="9" class="empty">No products yet. Add your first product.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}

  <!-- Product Form Modal -->
  {#if showProductForm}
    <div class="modal-overlay" onclick={() => showProductForm = false}>
      <div class="modal" onclick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h3>{editingProduct ? 'Edit Product' : 'Add Product'}</h3>
          <button class="close" onclick={() => showProductForm = false}>×</button>
        </div>
        <div class="modal-body">
          <label>Name *</label>
          <input type="text" bind:value={form.name} placeholder="Product name" />
          <label>Barcode</label>
          <input type="text" bind:value={form.barcode} placeholder="Barcode / SKU" />
          <label>Category</label>
          <input type="text" bind:value={form.category} placeholder="Category" />
          <div class="form-row">
            <div>
              <label>Price (₹) *</label>
              <input type="number" min="0" step="0.01" bind:value={form.price} />
            </div>
            <div>
              <label>Cost (₹)</label>
              <input type="number" min="0" step="0.01" bind:value={form.cost} />
            </div>
          </div>
          <div class="form-row">
            <div>
              <label>Stock</label>
              <input type="number" min="0" bind:value={form.stock} />
            </div>
            <div>
              <label>GST %</label>
              <input type="number" min="0" step="0.01" bind:value={form.gstRate} />
            </div>
          </div>
          <label>Image</label>
          <input type="file" accept="image/*" onchange={handleImageUpload} />
          {#if form.image}
            <img src={form.image} alt="Preview" class="form-preview" />
          {/if}
          <label class="checkbox">
            <input type="checkbox" bind:checked={form.active} /> Active
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn-ghost" onclick={() => showProductForm = false}>Cancel</button>
          <button class="btn-primary" onclick={saveProduct}>Save</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #0f1117;
    color: #e8eaed;
    min-height: 100vh;
    overflow-x: hidden;
  }
  :global(html, body, #app) { height: 100%; }

  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    max-width: 1400px;
    margin: 0 auto;
  }

  /* Topbar */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    position: sticky;
    top: 0;
    z-index: 50;
  }
  .logo-area {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .logo {
    height: 36px;
    width: auto;
    object-fit: contain;
  }
  .brand {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
  }
  .brand-name {
    font-weight: 700;
    font-size: 1.05rem;
    color: #3b82f6;
  }
  .brand-sub {
    font-size: 0.7rem;
    color: #8b949e;
    letter-spacing: 0.05em;
  }
  .mode-nav {
    display: flex;
    gap: 0.35rem;
  }
  .mode-nav button {
    background: transparent;
    border: 1px solid #30363d;
    color: #c9d1d9;
    padding: 0.4rem 0.9rem;
    border-radius: 8px;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .mode-nav button.active {
    background: #1f6feb;
    border-color: #1f6feb;
    color: #fff;
  }

  /* Toast */
  .toast {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%);
    background: #238636;
    color: #fff;
    padding: 0.6rem 1.2rem;
    border-radius: 8px;
    z-index: 100;
    font-size: 0.9rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem;
    overflow-x: auto;
    background: #161b22;
    border-bottom: 1px solid #30363d;
  }
  .tabs button {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: #8b949e;
    padding: 0.5rem 0.85rem;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .tabs button.active {
    background: #21262d;
    color: #58a6ff;
    font-weight: 600;
  }

  /* Billing layout */
  .billing-layout {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .billing-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
  }

  /* Photo POS */
  .photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 0.6rem;
  }
  .photo-card {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    color: inherit;
    padding: 0;
    transition: border-color 0.15s;
  }
  .photo-card:active { border-color: #1f6feb; }
  .photo-card img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    display: block;
  }
  .no-img {
    width: 100%;
    aspect-ratio: 1;
    background: #30363d;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.8rem;
    font-weight: 700;
    color: #58a6ff;
  }
  .photo-info {
    padding: 0.4rem 0.5rem;
  }
  .p-name {
    display: block;
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .p-price {
    font-size: 0.85rem;
    font-weight: 600;
    color: #3fb950;
  }

  /* Text POS */
  .search-input {
    width: 100%;
    padding: 0.75rem 1rem;
    font-size: 1rem;
    border-radius: 10px;
    border: 1px solid #30363d;
    background: #0d1117;
    color: #e8eaed;
    margin-bottom: 0.75rem;
  }
  .search-input:focus {
    outline: none;
    border-color: #1f6feb;
  }
  .hint, .empty {
    color: #8b949e;
    text-align: center;
    padding: 2rem 1rem;
    font-size: 0.95rem;
  }
  .result-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.65rem 0.75rem;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 8px;
    margin-bottom: 0.4rem;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }
  .result-row:active { border-color: #1f6feb; }
  .r-left {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    min-width: 0;
  }
  .thumb, .thumb-placeholder {
    width: 40px;
    height: 40px;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .thumb-placeholder {
    background: #30363d;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: #58a6ff;
  }
  .r-name { font-weight: 600; font-size: 0.9rem; }
  .r-meta { font-size: 0.75rem; color: #8b949e; }
  .r-price { font-weight: 700; color: #3fb950; flex-shrink: 0; margin-left: 0.5rem; }

  /* Lists */
  .list-view { display: flex; flex-direction: column; gap: 0.5rem; }
  .list-card {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 0.75rem 1rem;
  }
  .list-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.3rem;
  }
  .list-body { font-size: 0.85rem; color: #8b949e; }
  .list-actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }
  .badge {
    background: #1f6feb33;
    color: #58a6ff;
    font-size: 0.7rem;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
  }

  /* Calculator */
  .calculator {
    max-width: 280px;
    margin: 1rem auto;
    background: #21262d;
    border-radius: 16px;
    padding: 1rem;
    border: 1px solid #30363d;
  }
  .calc-display {
    background: #0d1117;
    border-radius: 10px;
    padding: 1rem;
    font-size: 1.8rem;
    text-align: right;
    margin-bottom: 0.75rem;
    font-variant-numeric: tabular-nums;
    min-height: 3rem;
    word-break: break-all;
  }
  .calc-keys {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.4rem;
  }
  .calc-keys button {
    background: #30363d;
    border: none;
    color: #e8eaed;
    font-size: 1.2rem;
    padding: 0.85rem 0;
    border-radius: 10px;
    cursor: pointer;
  }
  .calc-keys button:active { background: #1f6feb; }
  .calc-keys .equals {
    grid-row: span 2;
    background: #1f6feb;
  }
  .calc-keys .zero { grid-column: span 2; }

  /* Cart panel */
  .cart-panel {
    width: 320px;
    flex-shrink: 0;
    background: #161b22;
    border-left: 1px solid #30363d;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 52px);
  }
  .cart-panel h3 {
    padding: 0.75rem 1rem;
    font-size: 1rem;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .count {
    background: #1f6feb;
    color: #fff;
    font-size: 0.75rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }
  .cart-items {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
  }
  .empty-cart {
    text-align: center;
    color: #8b949e;
    padding: 2rem 0.5rem;
    font-size: 0.9rem;
  }
  .cart-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem;
    background: #21262d;
    border-radius: 8px;
    margin-bottom: 0.35rem;
  }
  .ci-info { flex: 1; min-width: 0; }
  .ci-name {
    display: block;
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ci-price { font-size: 0.75rem; color: #8b949e; }
  .ci-qty {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .ci-qty button {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid #30363d;
    background: #0d1117;
    color: #e8eaed;
    cursor: pointer;
    font-size: 1rem;
  }
  .ci-qty span { min-width: 1.2rem; text-align: center; font-size: 0.85rem; }
  .ci-remove {
    background: transparent;
    border: none;
    color: #f85149;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 0.2rem;
  }
  .cart-meta {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid #30363d;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .cart-meta input, .cart-meta select {
    width: 100%;
    padding: 0.45rem 0.6rem;
    border-radius: 6px;
    border: 1px solid #30363d;
    background: #0d1117;
    color: #e8eaed;
    font-size: 0.85rem;
  }
  .cart-meta .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .cart-meta .row label { font-size: 0.8rem; color: #8b949e; white-space: nowrap; }
  .cart-meta .row input, .cart-meta .row select { flex: 1; }
  .cart-totals {
    padding: 0.6rem 0.75rem;
    border-top: 1px solid #30363d;
    font-size: 0.85rem;
  }
  .cart-totals > div {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.25rem;
  }
  .cart-totals .grand {
    font-weight: 700;
    font-size: 1.1rem;
    margin-top: 0.35rem;
    color: #3fb950;
  }
  .cart-actions {
    display: flex;
    gap: 0.4rem;
    padding: 0.6rem 0.75rem 0.9rem;
    border-top: 1px solid #30363d;
  }
  .cart-actions button { flex: 1; }

  /* Buttons */
  .btn-primary {
    background: #1f6feb;
    color: #fff;
    border: none;
    padding: 0.55rem 1rem;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-secondary {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 0.55rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .btn-secondary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-ghost {
    background: transparent;
    color: #8b949e;
    border: 1px solid #30363d;
    padding: 0.55rem 0.8rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-danger {
    background: transparent;
    color: #f85149;
    border: 1px solid #f8514933;
    padding: 0.4rem 0.7rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .sm { padding: 0.3rem 0.6rem !important; font-size: 0.8rem !important; }

  /* Admin */
  .admin-layout {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .admin-content { padding: 1rem; flex: 1; overflow: auto; }
  .admin-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .admin-toolbar h2 { font-size: 1.2rem; }
  .product-table-wrap { overflow-x: auto; }
  .product-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  .product-table th, .product-table td {
    padding: 0.55rem 0.6rem;
    text-align: left;
    border-bottom: 1px solid #30363d;
  }
  .product-table th {
    background: #161b22;
    color: #8b949e;
    font-weight: 600;
    position: sticky;
    top: 0;
  }
  .tbl-img, .tbl-img-ph {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    object-fit: cover;
  }
  .tbl-img-ph {
    background: #30363d;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: #58a6ff;
  }
  .status {
    font-size: 0.75rem;
    color: #3fb950;
  }
  .status.off { color: #f85149; }
  .actions { display: flex; gap: 0.3rem; }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 80;
    padding: 1rem;
  }
  .modal {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 14px;
    width: 100%;
    max-width: 420px;
    max-height: 90vh;
    overflow-y: auto;
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.1rem;
    border-bottom: 1px solid #30363d;
  }
  .modal-header h3 { font-size: 1.05rem; }
  .close {
    background: none;
    border: none;
    color: #8b949e;
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
  }
  .modal-body {
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .modal-body label {
    font-size: 0.8rem;
    color: #8b949e;
    margin-top: 0.35rem;
  }
  .modal-body input[type="text"],
  .modal-body input[type="number"],
  .modal-body input[type="file"] {
    padding: 0.5rem 0.65rem;
    border-radius: 6px;
    border: 1px solid #30363d;
    background: #0d1117;
    color: #e8eaed;
    font-size: 0.9rem;
  }
  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .form-preview {
    max-width: 100px;
    max-height: 100px;
    border-radius: 8px;
    margin-top: 0.3rem;
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem !important;
    color: #c9d1d9 !important;
    font-size: 0.9rem !important;
  }
  .modal-footer {
    padding: 0.75rem 1.1rem 1rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    border-top: 1px solid #30363d;
  }

  /* Mobile */
  @media (max-width: 768px) {
    .billing-layout {
      flex-direction: column;
    }
    .cart-panel {
      width: 100%;
      max-height: 42vh;
      border-left: none;
      border-top: 1px solid #30363d;
    }
    .photo-grid {
      grid-template-columns: repeat(auto-fill, minmax(95px, 1fr));
    }
    .brand-name { font-size: 0.95rem; }
    .logo { height: 30px; }
  }
</style>
