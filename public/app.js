async function fetchProducts() {
  const res = await fetch("/api/products");
  return res.json();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

async function reserve(productId, qty) {
  const res = await fetch("/api/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, qty })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Reserve failed");
  return data;
}

async function reserveCash(productId, qty) {
  const res = await fetch("/api/reserve-cash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, qty })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Cash reserve failed");
  return data;
}

async function createOrder(reservationId) {
  const res = await fetch("/api/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId })
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Create order failed");
  return data.id;
}

async function captureOrder(orderID) {
  const res = await fetch("/api/capture-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderID })
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Capture failed");
  return data;
}

function dollars(cents) {
  return (cents / 100).toFixed(2);
}

async function render() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  const products = await fetchProducts();

  for (const p of products) {
    const card = el("div", { class: "card" });

    card.appendChild(el("h3", {}, [p.name]));
    card.appendChild(el("div", { class: "meta" }, [
      `$${dollars(p.price_cents)} • `,
      el("strong", {}, [`${p.stock} in stock`])
    ]));

    const qty = el("input", {
      type: "number",
      min: "1",
      max: String(p.stock),
      value: "1",
      class: "qty"
    });

    card.appendChild(qty);

    // PayPal buttons
    const paypalWrap = el("div", { class: "btnWrap" });
    card.appendChild(paypalWrap);

    if (typeof paypal !== "undefined") {
      paypal.Buttons({
        style: { layout: "vertical" },
        createOrder: async () => {
          const q = Math.max(1, Math.min(Number(qty.value || 1), p.stock));
          const r = await reserve(p.id, q);
          return await createOrder(r.reservationId);
        },
        onApprove: async (data) => {
          await captureOrder(data.orderID);
          alert("Payment complete! Inventory updated.");
          await render();
        },
        onCancel: async () => {
          alert("Checkout canceled. Your reserved stock will return after the hold expires.");
        }
      }).render(paypalWrap);
    } else {
      paypalWrap.textContent = "PayPal not loaded (check YOUR_CLIENT_ID in index.html).";
    }

    // Cash reserve button
    const cashBtn = el("button", { class: "cashBtn", type: "button" }, ["Cash pickup — Reserve"]);
    cashBtn.addEventListener("click", async () => {
      try {
        const q = Math.max(1, Math.min(Number(qty.value || 1), p.stock));
        const r = await reserveCash(p.id, q);
        alert(
          `Reserved!\n\nReservation code:\n${r.reservationId}\n\nMessage the seller this code to arrange pickup.`
        );
        await render();
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    card.appendChild(cashBtn);

    grid.appendChild(card);
  }
}

render().catch((e) => {
  document.getElementById("grid").textContent = "Error: " + (e.message || e);
});