import test from "node:test"; import assert from "node:assert/strict";
import {verifyX963Signature} from "../src/crypto";
test("P-256 X9.63 key verifies a signature",async()=>{const keys=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);const pub=await crypto.subtle.exportKey("raw",keys.publicKey);const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode("message"));assert.equal(await verifyX963Signature(Buffer.from(pub).toString("base64"),Buffer.from(sig).toString("base64"),"message"),true);});
