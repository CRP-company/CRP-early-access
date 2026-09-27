const fs = require("fs");
const jwt = require("jsonwebtoken");

const credentials = JSON.parse(
  fs.readFileSync("./crp-tester-card-4af9e80eb67f.json", "utf8")
);

const issuerId = "3388000000023210330";

const classId = `${issuerId}.crp_tester_loyalty`;
const objectId = `${issuerId}.crp_tester_loyalty_0004`;

const loyaltyClass = {
  id: classId,
  issuerName: "CRP",
  reviewStatus: "DRAFT",

  programName: "CRP TESTING PROGRAM",

  programLogo: {
    sourceUri: {
      uri: "https://i.postimg.cc/K8zf4q4q/CRPlogo.png"
    }
  },

  homepageUri: {
    uri: "https://crp-company.github.io/CRP-early-access/"
  },

  hexBackgroundColor: "#000000",

  multipleDevicesAndHoldersAllowedStatus: "MULTIPLE_HOLDERS"
};

const loyaltyObject = {
  id: objectId,
  classId: classId,
  state: "ACTIVE",

  accountId: "0003",
  accountName: "CRP Tester",

  barcode: {
    type: "QR_CODE",
    value: "CRP-TESTER-0003",
    alternateText: "CRP-TESTER-0003"
  }
};

const claims = {
  iss: credentials.client_email,
  aud: "google",
  origins: ["https://crp-company.github.io"],
  typ: "savetowallet",
  iat: Math.floor(Date.now() / 1000),

  payload: {
    loyaltyClasses: [
      loyaltyClass
    ],

    loyaltyObjects: [
      loyaltyObject
    ]
  }
};

const token = jwt.sign(
  claims,
  credentials.private_key,
  {
    algorithm: "RS256"
  }
);

console.log("\nADD TO GOOGLE WALLET:\n");
console.log(`https://pay.google.com/gp/v/save/${token}`);
