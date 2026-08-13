# Taxonomy

The classification contract. The seed migration in `supabase/migrations/` must
agree with this file; change both in the same commit. The Phase 3 extraction
prompt is built from the rules below, and the Phase 4+ semantic layer assumes
them. This file is generic by design — personal lookup values (accounts,
income sources, funding sources, personal tags, merchants) live in the
untracked personal seed overlay described in [DATA_MODEL.md](DATA_MODEL.md).

## Three levels

Every expense line item is classified on up to three levels, each answering a
different question:

| Level | Question it answers |
|---|---|
| **Category** | What broad area of spending is this? |
| **Subcategory** | Through what purchasing or consumption channel? |
| **Item type** | What kind of thing was actually purchased? *(only where it earns its keep)* |

Item types exist only for categories where the subcategory and the item type
answer *different* useful questions. Elsewhere they would be redundant
metadata and are deliberately absent. The rule for adding one later: add a
third level only when the subcategory answers one useful question and the
item type answers a different one.

## Categories and subcategories

| Category | Subcategories |
|---|---|
| Bills | Internet and phone · Utilities · Other bills |
| Food and drink | Groceries · Restaurants · Takeout / Quick Service · Delivery · Bars and nightlife · Other food and drink |
| Health and wellness | Fitness · Medical · Hygiene · Other health |
| Housing | Rent · Home and renter's insurance · Mortgage · Household supplies · Household goods · Laundry · Property taxes · Other housing |
| Finances | Financial fees · Taxes · Personal loans · Student loans · Other finances |
| Personal | Beauty · Entertainment and activities · Hobbies · Bets · Pets · Other personal |
| Career and professional | Education and training · Software and digital · Equipment · Certifications and career · Other career and professional |
| Shopping | Clothing and accessories · Gifts · Memberships · Other shopping |
| Transportation | Auto insurance · Maintenance · Car loan payments · Gas, parking and tolls · Public transit · Taxis and rideshares · Other transportation |
| Travel | Flights · Hotels · Other travel |
| Immigration and legal | Immigration · Government IDs and documents · Legal and professional services · Other immigration and legal |

Definitions that need more than their name:

- **Household supplies** — consumed and replaced regularly: paper towels,
  garbage bags, cleaning solution, sponges.
- **Household goods** — physical things for the home expected to last:
  furniture, cookware, dishes, bedding, lamps, appliances.
- **Financial fees** — charges imposed by banks, card issuers, payment
  providers, or investment platforms for providing or administering a
  financial service.
- **Education and training** — money spent learning professional skills:
  courses, workshops, technical books, bootcamps.
- **Software and digital** (Career) — digital tools/infrastructure needed to
  do professional work or build professional projects: cloud providers, APIs,
  paid developer services, domains, hosting.
- **Equipment** (Career) — physical things bought primarily for work or
  professional projects: microphone, webcam, monitor bought for work.
- **Certifications and career** — proving qualifications or advancing/finding
  work rather than learning itself: exam fees, professional memberships,
  résumé services, networking events.

Every category has an "Other …" subcategory. It is a fallback, not a common
classification: prefer a specific subcategory whenever the available
information reasonably supports one.

## Food and drink

The subcategory describes **how or through what channel** the food or drink
was obtained. The item type describes **what the item actually is**. Never
let one override the other.

### Subcategories (channel)

- **Groceries** — food or beverages purchased as *retail goods* rather than
  through a food-service transaction. Not limited to food prepared at home;
  eventual place of consumption is irrelevant. Chips from a dépanneur,
  gummies from a dollar store, wine from a liquor store, a rotisserie chicken
  bought inside a warehouse store — all Groceries.
- **Restaurants** — sit-down / table-service dining.
- **Takeout / Quick Service** — prepared food from a counter- or quick-service
  establishment, without table service and without delivery. Eating it inside
  the establishment does not change the classification. Fast food, food
  courts, café and bakery counters, restaurant pickup, concession stands.
- **Delivery** — prepared food or beverages delivered to the customer, via a
  platform or the establishment itself. The delivery method determines the
  subcategory even when the establishment would otherwise be a restaurant.
  Delivery fees tied to a food order belong to the same transaction.
- **Bars and nightlife** — purchases whose context is primarily drinking,
  nightlife, or going out socially rather than ordinary dining. Includes food
  ordered at a drinking-focused venue and cover charges.
- **Other food and drink** — genuine fallback only.

### Item types (what)

| Item type | Covers |
|---|---|
| Ingredients & Staples | Raw meat, fish, rice, pasta, eggs, produce, bread, cheese, milk, cooking ingredients, canned/frozen basics |
| Meals & Prepared Food | Burgers, pizza, sandwiches, sushi, prepared salads, entrées, ready-to-eat retail meals |
| Snacks & Sweets | Candy, chips, chocolate, cookies, ice cream, pastries bought as a snack |
| Non-Alcoholic Beverages | Coffee, tea, matcha, bubble tea, soft drinks, juice, smoothies, energy drinks, water |
| Alcoholic Beverages | Beer, wine, spirits, cocktails, hard seltzer |
| Other Food & Drink | Genuine fallback only |

The two dimensions combine freely; the channel never changes what the item
is, and vice versa:

- Cappuccino at a restaurant → Restaurants → Non-Alcoholic Beverages
- Cappuccino from a café counter → Takeout / Quick Service → Non-Alcoholic Beverages
- Bottled coffee from a supermarket → Groceries → Non-Alcoholic Beverages
- Wine with a restaurant dinner → Restaurants → Alcoholic Beverages
- Wine from a supermarket → Groceries → Alcoholic Beverages
- Beer at a nightclub → Bars and nightlife → Alcoholic Beverages

## Housing item types

Cleaning Product · Paper Product · Laundry Supply · Kitchenware · Bedding ·
Small Appliance · Furniture

The subcategory (Household supplies vs. Household goods) carries the
financial function — consumable vs. durable — while the item type says what
was bought. Both questions stay independently answerable.

## Health and wellness item types

Oral Care · Body Care · Medication · Medical Device · Equipment · Membership

Kept deliberately restrained; this is not a medical ontology.

## Classification rules

1. Classify **individual receipt line items** whenever reliable line-item
   data is available. Do not assign one classification to a whole receipt.
2. The **merchant does not determine the category**. A single dollar-store or
   warehouse receipt can contain Food and drink, Housing, and Personal items;
   each line is classified by its own financial purpose. Use merchant
   information only as evidence about the purchasing context.
3. Items from the same food-service transaction generally share a
   subcategory but may have different item types (burger → Meals & Prepared
   Food, soft drink → Non-Alcoholic Beverages, both under the same channel).
4. Do not assume all supermarket items are Ingredients & Staples, nor that
   all restaurant items are Meals & Prepared Food.
5. A warehouse-store *food court* purchase is a food-service transaction
   (Takeout / Quick Service) even though the merchant is primarily a
   retailer; retail goods bought inside the same store remain Groceries.
6. Food bought retail for an outing (e.g. picnic cheese and crackers) is
   Groceries; prepared food bought from a café for the same outing is
   Takeout / Quick Service. Where it will be eaten never matters.
7. Use "Other …" only when the available information cannot support a more
   specific classification. When genuinely ambiguous, prefer the option that
   best reflects the economic nature of the purchase; do not invent detail.

## Needs / wants bucket

The bucket is a per-line judgment, not a property of the subcategory (the
same Groceries run contains staples and indulgences). Subcategories carry a
nullable `default_bucket` that seeds the extraction prompt's suggestion;
the human confirms or overrides per line. Transfers to savings or
investment accounts are not expenses and have no bucket — they are
`type = 'transfer'` transactions.
