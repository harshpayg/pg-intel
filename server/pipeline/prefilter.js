// Cheap regex gate in front of the LLM. Drops roughly 80-90% of items.
const RE = {
  india: /\b(india|indian|bharat|bengaluru|bangalore|mumbai|delhi|ncr|gurugram|gurgaon|noida|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|surat|kochi|chandigarh|indore|coimbatore|lucknow|tiruppur|ludhiana|moradabad|kanpur|vadodara|nagpur|bhubaneswar|visakhapatnam|mysuru|mangaluru|thiruvananthapuram)\b|₹|\b(crore|lakh)s?\b|\brs\.?\s?\d|\binr\b/i,
  funding: /\b(raises?|raised|raising|secures?|secured|bags?|bagged|lands?|nets?|mops? up|closes?|funding|funded|seed|pre-seed|angel round|series [a-f]|pre-series|investment|invests?|backed|led by|valuation|debt round|bridge round)\b/i,
  expansion: /\b(expands?|expanding|expansion|enters?|entry into|forays?|launch(es|ed)? in|global|globally|international|overseas|abroad|export(s|er|ers|ing)?|us market|uk market|united states|america|uae|dubai|saudi|middle east|gcc|europe|germany|singapore|southeast asia|australia|africa|cross-border|worldwide|diaspora|nri)\b/i,
  launch: /\b(launch(es|ed)?|unveils?|introduces?|rolls out|partners? with|partnership|acquires?|acquisition|opens? (office|store)|hiring|hires)\b/i,
  pain: /\b(stripe|paypal|payoneer|wise\.com|skydo|xflow|razorpay|cashfree|international payments?|receive payments?|foreign clients?|clients abroad|usd payments?|firc|fira|ebrc|e-brc|lut|export of services|swift|forex|wire transfer|chargebacks?|payment gateway|merchant account|international cards?|gst on exports?|invoic(e|ing) (us|foreign|international))\b/i,
  regulatory: /\b(rbi|reserve bank|payment aggregator|pa-cb|cross[- ]border|fema|dgft|foreign trade policy|export|import|forex|lrs|remittance|kyc|aml|psp|payments? system|upi|rupee|data localisation|dpdp|tariff|trade deal|fta|edpms)\b/i,
  competitor: /\b(skydo|xflow|briskpe|razorpay|cashfree|paypal|stripe|payoneer|wise|airwallex|payu|ccavenue|juspay|easebuzz|infibeam|payglocal)\b/i,
  noise: /\b(sensex|nifty|share price|stock(s)? (to buy|rally|fall)|q[1-4] (results|earnings)|quarterly results|ipo (gmp|subscription|allotment)|horoscope|cricket|bollywood|box office|recipe|weather|election|monsoon)\b/i,
  rbiNoise: /\b(money market operations|auction|treasury bills?|weekly statistical|reference rate|lending facility|state government securities|sdl|ways and means|government stock|cut-off|repo (auction|operations)|vrrr|vrr|liquidity adjustment|penalty on|imposes (monetary )?penalty|cancels (the )?certificate|directions under section 35a|amalgamation of)\b/i,
};

export function prefilter(item, source) {
  const text = `${item.title} ${item.summary || ''}`;
  const hits = {};
  for (const [k, re] of Object.entries(RE)) hits[k] = re.test(text);

  if (item.meta?.entity) return { pass: true, route: 'structured', hits };

  const cat = source.category;
  if (cat === 'intel') {
    if (source.id.startsWith('rbi')) {
      // Every RBI item says "RBI"; keep only ones touching payments, forex or trade.
      const topical = /\b(payment|aggregator|cross[- ]border|fema|forex|foreign exchange|export|import|remittance|lrs|kyc|upi|card|digital|data localisation|fintech|psp|edpms|rupee invoicing|vostro|merchant)\b/i.test(text);
      const pass = topical && !hits.rbiNoise;
      return { pass, route: 'intel', reason: pass ? null : 'routine RBI notice', hits };
    }
    const pass = hits.regulatory || hits.competitor || hits.pain;
    return { pass, route: 'intel', reason: pass ? null : 'no payments/regulatory relevance', hits };
  }

  if (hits.noise && !hits.funding) return { pass: false, reason: 'market noise', hits };

  if (cat === 'voice') {
    // Reddit: keep posts about getting paid from abroad, or founders describing their global business.
    const pass = hits.pain || (hits.expansion && (hits.india || source.id.startsWith('rd-')));
    return { pass, route: 'voice', reason: pass ? null : 'no payment pain or global intent', hits };
  }

  const india = hits.india || source.params?.assumeIndia || /^(inc42|entrackr|yourstory|et-startups)/.test(source.id);
  const intent = hits.funding || hits.expansion || hits.launch || hits.pain;
  if (!intent) return { pass: false, reason: 'no funding/expansion/launch signal', hits };
  if (!india && source.kind !== 'hn') return { pass: false, reason: 'no India signal', hits };
  if (source.kind === 'hn' && !hits.india) return { pass: false, reason: 'no India signal', hits };
  return { pass: true, route: 'leads', hits };
}
