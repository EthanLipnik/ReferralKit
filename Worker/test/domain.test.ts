import test from "node:test"; import assert from "node:assert/strict";
import {decryptOfferCode,encryptOfferCode,normalizeCode,randomCode,sha256} from "../src/crypto"; import {config} from "../src/env";
import {hasPriorProPurchaseOrTrial} from "../src/revenuecat"; import {existingCode,rewardMonthsForBalance,senderOfferID,senderRewardKind,senderRewardProduct} from "../src/domain";
test("codes are opaque, readable, and normalize client compact form",()=>{const c=randomCode("EXMP");assert.match(c,/^EXMP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);assert.equal(normalizeCode(c.replaceAll("-",""),"EXMP"),c);});
test("existing referral code is returned without creating a replacement",async()=>{
    const env={PUBLIC_SITE_URL:"https://example.com",DB:{prepare:()=>({bind:(accountID:string)=>({first:async()=>{assert.equal(accountID,"account-1");return {display_code:"EXMP-AAAA-BBBB-CCCC"};}})})}} as any;
    assert.deepEqual(await existingCode(env,"account-1"),{code:"EXMP-AAAA-BBBB-CCCC",url:"https://example.com/r/EXMP-AAAA-BBBB-CCCC"});
});
test("canonical empty body hash is stable",async()=>assert.equal(await sha256(""),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
test("remote limits clamp to compiled fraud ceilings",()=>{const c=config({CONFIG_JSON:JSON.stringify({schemaVersion:1,enabled:true,maxBankedCredits:999,maxCreditsPerRedemption:999,extensionWindowDays:999,maxRewardedReferralsPerRolling30Days:999,reservationMinutes:999}),} as any);assert.equal(c.maxBankedCredits,24);assert.equal(c.maxCreditsPerRedemption,12);assert.equal(c.extensionWindowDays,14);assert.equal(c.maxRewardedReferralsPerRolling30Days,10);assert.equal(c.reservationMinutes,60);assert.equal(c.enabled,true);});
test("malformed config fails closed for enrollment",()=>assert.equal(config({CONFIG_JSON:"{"} as any).enabled,false));
test("recipient eligibility rejects every prior Pro subscription period",()=>{
    const monthly="example_pro_monthly",yearly="example_pro_yearly";
    assert.equal(hasPriorProPurchaseOrTrial({subscriptions:{}},monthly,yearly),false);
    assert.equal(hasPriorProPurchaseOrTrial({subscriptions:{[monthly]:{period_type:"trial",purchase_date:"2026-01-01"}}},monthly,yearly),true);
    assert.equal(hasPriorProPurchaseOrTrial({subscriptions:{[yearly]:{period_type:"normal",purchase_date:"2026-01-01"}}},monthly,yearly),true);
    assert.equal(hasPriorProPurchaseOrTrial({subscriptions:{[monthly]:{period_type:"intro",expires_date:"2025-01-01"}}},monthly,yearly),true);
});
test("recipient eligibility rejects a prior lifetime purchase",()=>{
    assert.equal(hasPriorProPurchaseOrTrial({non_subscriptions:{example_pro_lifetime:[{purchase_date:"2026-01-01"}]}},"monthly","yearly",["example_pro_lifetime"]),true);
    assert.equal(hasPriorProPurchaseOrTrial({non_subscriptions:{example_pro_lifetime:[]}},"monthly","yearly",["example_pro_lifetime"]),false);
});
test("sender rewards preserve an active subscription product and use offer codes for new customers",()=>{
    assert.equal(senderRewardProduct({activeSubscriptionProduct:"yearly"} as any,"monthly"),"yearly");
    assert.equal(senderRewardProduct({} as any,"monthly"),"monthly");
    assert.equal(senderRewardKind({hasPriorSubscription:true} as any),"promotional_offer");
    assert.equal(senderRewardKind({hasPriorSubscription:false} as any),"offer_code");
});
test("banked rewards select the largest supported Apple duration without spending the remainder",()=>{
    const cases:[[number,number],number][]=[[[1,12],1],[[2,12],2],[[3,12],3],[[4,12],3],[[5,12],3],[[6,12],6],[[11,12],6],[[12,12],12],[[24,12],12],[[12,3],3]];
    for(const [[balance,maximum],expected] of cases)assert.equal(rewardMonthsForBalance(balance,maximum),expected);
});
test("sender promotional offers map every supported duration for monthly and yearly products",()=>{
    const env={
        SENDER_MONTHLY_PROMOTIONAL_OFFER_ID:"m1",SENDER_MONTHLY_PROMOTIONAL_OFFER_2_MONTHS_ID:"m2",SENDER_MONTHLY_PROMOTIONAL_OFFER_3_MONTHS_ID:"m3",SENDER_MONTHLY_PROMOTIONAL_OFFER_6_MONTHS_ID:"m6",SENDER_MONTHLY_PROMOTIONAL_OFFER_12_MONTHS_ID:"m12",
        SENDER_YEARLY_PROMOTIONAL_OFFER_ID:"y1",SENDER_YEARLY_PROMOTIONAL_OFFER_2_MONTHS_ID:"y2",SENDER_YEARLY_PROMOTIONAL_OFFER_3_MONTHS_ID:"y3",SENDER_YEARLY_PROMOTIONAL_OFFER_6_MONTHS_ID:"y6",SENDER_YEARLY_PROMOTIONAL_OFFER_12_MONTHS_ID:"y12",
        SENDER_NEW_MONTHLY_OFFER_ID:"new-monthly",SENDER_NEW_YEARLY_OFFER_ID:"new-yearly"
    } as any;
    for(const months of [1,2,3,6,12] as const){assert.equal(senderOfferID(env,"monthly","promotional_offer",months),`m${months}`);assert.equal(senderOfferID(env,"yearly","promotional_offer",months),`y${months}`);}
    assert.equal(senderOfferID(env,"monthly","offer_code",1),"new-monthly");
});
test("Apple offer codes are encrypted with authenticated encryption",async()=>{
    const key=Buffer.alloc(32,7).toString("base64"),code="ABCDEF123456";
    const encrypted=await encryptOfferCode(key,code);
    assert.notEqual(encrypted.includes(code),true);
    assert.equal(await decryptOfferCode(key,encrypted),code);
    await assert.rejects(()=>decryptOfferCode(Buffer.alloc(32,8).toString("base64"),encrypted));
});
