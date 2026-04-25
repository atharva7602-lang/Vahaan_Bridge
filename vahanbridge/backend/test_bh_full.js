const http = require('http');

async function testBH() {
  const payload = {
    eligibilityType: 'private',
    firstName: 'Test',
    lastName: 'User',
    mobile: '9876543210',
    resState: 'Maharashtra',
    vehicleType: '4w',
    fuelType: 'petrol',
    vehicleMake: 'Honda',
    vehicleModel: 'City',
    engineCC: '1498',
    vehicleYear: '2023',
    orgName: 'Acme Corp',
    invoiceAmount: '1200000',
    district: 'Pune',
    pincode: '411001',
    city: 'Pune',
    address: '123 Main St',
    employeeId: 'EMP123',
    designation: 'Manager',
    officeCity: 'Pune'
  };

  try {
    const res = await fetch('http://localhost:5000/api/bh/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    console.log("Status:", res.status);
    console.log("Data:", data);
  } catch (err) {
    console.error(err);
  }
}

testBH();
