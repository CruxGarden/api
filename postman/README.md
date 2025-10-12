# Crux Garden Postman Collection

This directory contains Postman collections and environments for testing the Crux Garden API.

## Files

- **Crux_Garden_Home_and_Attachments.postman_collection.json** - Collection for Home and Attachment endpoints
- **Crux_Garden_Local.postman_environment.json** - Environment variables for local development

## Setup Instructions

### 1. Import into Postman

1. Open Postman
2. Click **Import** button (top left)
3. Drag and drop both JSON files or click "Upload Files"
4. Import the collection and environment

### 2. Select Environment

1. Click the environment dropdown (top right)
2. Select **"Crux Garden - Local"**

### 3. Get Authentication Token

Before using the Home and Attachment endpoints, you need to authenticate:

**Option A: Use existing auth collection (if available)**
- Run the auth requests to get an `access_token`
- The token will be automatically saved to the environment

**Option B: Manual authentication**
1. Get an auth code:
   ```bash
   POST {{base_url}}/auth/code
   {
     "email": "your@email.com"
   }
   ```

2. Check your email for the code, then login:
   ```bash
   POST {{base_url}}/auth/login
   {
     "email": "your@email.com",
     "code": "YOUR_CODE_FROM_EMAIL"
   }
   ```

3. Copy the `accessToken` from the response
4. In Postman, set the environment variable:
   - Name: `access_token`
   - Value: (paste the token)

### 4. Set Up Test Data

Create some test resources to work with:

1. **Create a Crux** (to attach files to):
   ```bash
   POST {{base_url}}/cruxes
   {
     "slug": "test-crux",
     "title": "Test Crux",
     "data": "Test content"
   }
   ```
   Copy the `key` from the response and set `crux_key` environment variable.

2. **Get Primary Home** (or create one if you're an admin):
   ```bash
   GET {{base_url}}/homes
   ```
   Copy a `key` from the response and set `home_key` environment variable.

## Collection Structure

### 📁 Homes
Endpoints for managing homes (containers for organizing resources).

| Method | Endpoint | Description | Auth Required | Role Required |
|--------|----------|-------------|---------------|---------------|
| GET | `/homes` | List all homes (paginated) | Yes | Any |
| GET | `/homes/:homeKey` | Get specific home | Yes | Any |
| POST | `/homes` | Create new home | Yes | **Admin** |
| PATCH | `/homes/:homeKey` | Update home | Yes | **Admin** |
| DELETE | `/homes/:homeKey` | Delete home (soft) | Yes | **Admin** |

**Key Features:**
- Pagination support with `page` and `perPage` query params
- Link and Pagination headers in responses
- Admin-only write operations

### 📁 Attachments

#### Crux Attachments
Nested endpoints for attaching files to cruxes.

| Method | Endpoint | Description | Auth Required | Owner Required |
|--------|----------|-------------|---------------|----------------|
| GET | `/cruxes/:cruxKey/attachments` | List crux attachments | Yes | No |
| POST | `/cruxes/:cruxKey/attachments` | Upload file to crux | Yes | Yes |
| GET | `/cruxes/:cruxKey/attachments/:key/download` | Download file | Yes | No |

#### Attachment Management
Direct attachment operations by key.

| Method | Endpoint | Description | Auth Required | Owner Required |
|--------|----------|-------------|---------------|----------------|
| PUT | `/attachments/:attachmentKey` | Update attachment | Yes | Yes |
| DELETE | `/attachments/:attachmentKey` | Delete attachment | Yes | Yes |

**Key Features:**
- File uploads via multipart/form-data
- Max file size: 50MB
- S3 storage with PostgreSQL metadata
- Supports images, documents, videos, audio
- Owner-based access control

### 📁 Examples
Example requests demonstrating error scenarios:
- 401 Unauthorized (no token)
- 403 Forbidden (insufficient permissions)
- 404 Not Found (invalid resource)
- 400 Bad Request (validation errors)
- 400 File Too Large (exceeds 50MB)

## Environment Variables

The environment includes the following variables:

| Variable | Description | Auto-set | Required |
|----------|-------------|----------|----------|
| `base_url` | API base URL | No | Yes |
| `access_token` | JWT access token | By auth requests | Yes |
| `refresh_token` | JWT refresh token | By auth requests | No |
| `home_key` | Test home key | By GET homes | No |
| `attachment_key` | Test attachment key | By POST attachment | No |
| `crux_key` | Test crux key | Manually | No |
| `account_id` | Current account ID | By auth | No |
| `author_id` | Current author ID | Manually | No |

**Note:** Many variables are automatically set by test scripts when requests succeed.

## Working with Attachments

### Uploading Files

1. **Select the "Upload Attachment to Crux" request**
2. Go to **Body** tab (should show "form-data")
3. For the `file` field:
   - Hover over the field
   - Click **"Select Files"**
   - Choose your file
4. Adjust `type`, `kind`, and `meta` fields as needed
5. Click **Send**

**Supported types/kinds:**
- Type: `image`, `document`, `video`, `audio`, `other`
- Kind: `photo`, `screenshot`, `diagram`, `pdf`, `recording`, etc.

### Updating Attachments

**Metadata Only** (no file replacement):
- Use JSON body
- Content-Type: application/json
- Update `type`, `kind`, or `meta`

**With New File**:
- Use form-data body
- Content-Type: multipart/form-data
- Include `file` field with new file
- Optionally update other fields

### Downloading Files

The download endpoint returns:
- Binary file data
- `Content-Type` header with file's MIME type
- `Content-Disposition` header with filename
- `Cache-Control` header (1 year cache)

In Postman, click **Save Response** > **Save to a file** to download.

## Test Scripts

The collection includes automated test scripts that:

1. **Validate response status codes**
2. **Check response structure**
3. **Verify required fields**
4. **Automatically save keys to environment**
5. **Log errors for debugging**
6. **Verify response times**

View test results in the **Test Results** tab after running a request.

## Common Use Cases

### Creating a Complete Home

```javascript
// 1. Create home (as admin)
POST /homes
{
  "name": "My Knowledge Garden",
  "description": "Personal knowledge base",
  "type": "personal",
  "kind": "garden",
  "primary": false,
  "meta": {
    "color": "blue",
    "icon": "tree"
  }
}

// 2. Update home
PATCH /homes/{{home_key}}
{
  "description": "Updated description"
}

// 3. Get home details
GET /homes/{{home_key}}
```

### Working with Attachments

```javascript
// 1. Upload file to crux
POST /cruxes/{{crux_key}}/attachments
Form-data:
- file: [select file]
- type: "image"
- kind: "screenshot"
- meta: '{"caption": "Dashboard screenshot"}'

// 2. List all attachments for crux
GET /cruxes/{{crux_key}}/attachments

// 3. Update attachment metadata
PUT /attachments/{{attachment_key}}
{
  "type": "document",
  "meta": {"reviewed": true}
}

// 4. Download file
GET /cruxes/{{crux_key}}/attachments/{{attachment_key}}/download

// 5. Delete attachment
DELETE /attachments/{{attachment_key}}
```

## Tips

1. **Run requests in order** - Collection is organized logically
2. **Check test scripts** - They auto-populate environment variables
3. **Use Collection Runner** - Test multiple requests at once
4. **Check Console** - View detailed logs (View > Show Postman Console)
5. **Save responses** - Use "Save Response" for downloads
6. **Use variables** - Leverage `{{variable}}` syntax for dynamic values

## Troubleshooting

### 401 Unauthorized
- Check that `access_token` environment variable is set
- Token may have expired (1 hour TTL) - get a new one
- Verify token is valid JWT format

### 403 Forbidden
- **For homes:** Check that your account has `admin` role
- **For attachments:** Verify you own the resource
- Check token payload: `jwt.io` can decode tokens

### 404 Not Found
- Verify the key/ID exists
- Check that resource hasn't been soft-deleted
- Ensure you're using the correct environment

### 400 Bad Request (File Upload)
- Check file size (max 50MB)
- Verify all required fields are present
- Ensure `Content-Type` is `multipart/form-data`
- Check `meta` field is valid JSON string

### 500 Internal Server Error
- Check server logs
- Verify database is running
- Check S3 credentials (for attachments)
- Ensure Redis is running (for auth)

## API Documentation

For complete API documentation, visit:
- Swagger UI: `http://localhost:10000/api`
- ReDoc: `http://localhost:10000/redoc`

## Support

For issues or questions:
- Check the server logs: `npm run start:dev`
- Review test coverage: `npm run test`
- See integration tests: `test/attachment.integration-spec.ts`

## Version History

- **v1.0** (2025-01-12) - Initial collection for Home and Attachment endpoints
