async function testFee() {
  const payload = {
    vehicleType: '4w',
    engineCC: '1498',
    fuelType: 'petrol'
  };

  try {
    const res = await fetch('http://localhost:5000/api/bh/calculate-fee', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    console.log("Fee Status:", res.status);
    console.log("Fee Data:", data);
  } catch (err) {
    console.error(err);
  }
}

testFee();
