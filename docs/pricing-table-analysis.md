# Membership Pricing Table Analysis

## Overview

The membership pricing table (`AIRTABLE_PRICING_TABLEID` / `tblFmVdqWLiJxb1lD`) is a critical component of the UTS Startup Portal that determines monthly membership fees based on member types and discount categories.

## Current Implementation

### Table Structure (Airtable)

**Required Columns:**
- `Membership Type` - The type of membership (Full/Casual/Day)
- `Base Rate` - Standard monthly fee for this membership type

**Discount Columns (all optional):**
- `Current UTS Student`
- `Current Staff`
- `UTS Alumni < 12m`
- `UTS Alumni > 12m`
- `Former Staff < 12m`
- `Former Staff > 12m`

### Data Flow

1. **Loading Phase** (`loadPricingMatrixViaSDK()`)
   - Fetches all records from pricing table
   - Parses each row by membership type
   - Extracts base rate and all discount rates
   - Returns structured object: `{ [membershipType]: { base: number, discounts: {...} } }`

2. **Calculation Phase** (used in two places)
   - `buildPdfPayload()` - Calculates fee for PDF agreement generation
   - `/pricing-preview/:token` - Real-time pricing preview for dashboard

3. **Rate Selection Logic**
   ```
   For each team member:
   1. Get membership type (Full/Casual/Day)
   2. Get discount category (from validation or manual override)
   3. Check if discount is validated
   4. If validated:
      - Map category to column name
      - Use discount rate if found
      - Otherwise use base rate
   5. If not validated:
      - Use base rate
   6. Day memberships are excluded from monthly fees
   ```

### Code Locations

**Primary Implementation:**
- `server.js:2240-2290` - `loadPricingMatrixViaSDK()` function
- `server.js:2156-2187` - `discountColumnFor()` mapping function
- `server.js:2374-2423` - Pricing calculation in PDF payload
- `server.js:3493-3551` - Duplicate implementation for pricing preview

**Helper Functions:**
- `normaliseType()` - Standardizes membership type strings
- `effectiveDiscountCategory()` - Gets active discount category (manual or API)
- `isDiscountValidated()` - Checks if discount is validated
- `discountColumnFor()` - Maps category string to table column name

### Hardcoded Assumptions

1. **Column Names** - Exact column names are hardcoded:
   - "Membership Type"
   - "Base Rate"
   - "Current UTS Student"
   - "Current Staff"
   - "UTS Alumni < 12m"
   - "UTS Alumni > 12m"
   - "Former Staff < 12m"
   - "Former Staff > 12m"

2. **Membership Type Normalization**
   - "full" → "Full Membership"
   - "casual" → "Casual Membership"
   - "day" → "Day Membership"
   - Default → "Casual Membership"

3. **Fallback Logic**
   - If "Current UTS Student" or "Current Staff" column missing, falls back to "UTS Alumni < 12m" rate

4. **String Parsing**
   - Rates extracted using regex: `/[^0-9.\-]/g`
   - Converts strings like "$150" or "150.00" to numbers

## Current Limitations

### 1. **Inflexibility**
- Column names cannot be changed without code changes
- Cannot add new discount categories without updating code
- Cannot change membership types without updating normalization logic

### 2. **Code Duplication**
- `loadPricingMatrixViaSDK()` exists in two places (lines 2240 and 3493)
- `discountColumnFor()` duplicated (lines 2156 and 3412)
- Helper functions repeated across endpoints

### 3. **Scalability Issues**
- Adding new discount categories requires:
  - Updating Airtable table structure
  - Modifying `loadPricingMatrixViaSDK()` to parse new columns
  - Updating `discountColumnFor()` mapping logic
  - Testing all affected endpoints

### 4. **Configuration Rigidity**
- No dynamic column discovery
- No support for custom discount naming
- No validation of table structure

### 5. **Error Handling**
- Silent failures if columns missing
- No validation that required columns exist
- Falls back to base rate if discount column not found

## Refactoring Opportunities

### Option 1: Dynamic Column Discovery
**Approach:** Query table schema, discover columns dynamically
- **Pros:** Flexible, supports any column names
- **Cons:** Complex mapping logic, harder to validate

### Option 2: Configuration-Based Mapping
**Approach:** Store column mappings in environment variables or config file
```env
PRICING_COLUMN_TYPE=Membership Type
PRICING_COLUMN_BASE=Base Rate
PRICING_DISCOUNT_CURRENT_STUDENT=Current UTS Student
PRICING_DISCOUNT_ALUMNI_12M=UTS Alumni < 12m
...
```
- **Pros:** Flexible without code changes
- **Cons:** More environment variables to manage

### Option 3: Metadata Table Approach
**Approach:** Add metadata table defining column mappings and discount categories
- **Pros:** Self-documenting, admin-manageable
- **Cons:** Additional complexity, requires migration

### Option 4: Convention-Based Discovery
**Approach:** Use naming conventions to auto-discover discount columns
```
Pattern: Any column starting with "Discount:" is a discount category
Example columns:
- Discount: Current UTS Student
- Discount: Alumni < 12m
- Discount: Custom Category X
```
- **Pros:** Simple, flexible, no code changes for new categories
- **Cons:** Requires table restructure, breaks existing data

### Option 5: Structured Pricing Table Redesign
**Approach:** Normalize pricing into relational structure
```
Pricing Table:
- Membership Type
- Discount Category (linked)
- Rate

Discount Categories Table:
- Category Name
- Description
- Active (boolean)
```
- **Pros:** Fully normalized, infinitely flexible
- **Cons:** Major refactor, breaks existing integrations

## Recommended Approach

**Hybrid: Convention-Based + Environment Overrides**

1. **Phase 1 - Extract to Shared Module**
   - Consolidate duplicated code into single shared module
   - Add comprehensive error handling and logging
   - Maintain current functionality

2. **Phase 2 - Add Dynamic Discovery**
   - Discover columns matching pattern `^(Discount:|Rate:)`
   - Fall back to hardcoded names for backward compatibility
   - Add table structure validation

3. **Phase 3 - Configuration Layer**
   - Add optional environment variable overrides
   - Support custom column mapping
   - Maintain convention as default

### Implementation Benefits
- **Backward compatible** - existing tables continue working
- **Future flexible** - new categories via naming convention
- **Maintainable** - consolidated code, better error handling
- **Configurable** - optional customization via environment

## Migration Considerations

1. **Data Continuity**
   - Existing pricing data must remain accessible
   - No breaking changes to current table structure
   - Gradual migration path

2. **Testing Requirements**
   - Unit tests for pricing calculations
   - Integration tests for each discount category
   - Validation of edge cases (missing columns, invalid rates)

3. **Documentation**
   - Admin guide for managing pricing table
   - Developer docs for pricing logic
   - Migration guide if structure changes

## Related Code to Review

- `validation_generation/server_reference.js:1345-1400` - Legacy pricing implementation
- `docs/canonical-integration-spec.md` - Pricing table specification
- Environment variables: `AIRTABLE_PRICING_TABLEID`

## Next Steps

1. Decide on refactoring approach
2. Create detailed implementation plan
3. Set up test coverage for pricing logic
4. Implement changes incrementally
5. Validate with existing data
6. Document new capabilities
