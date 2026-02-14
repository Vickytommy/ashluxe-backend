import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: "af-south-1",
});

let cachedSecrets = null;

export async function loadSecrets() {
  if (cachedSecrets) return cachedSecrets;

  try {
    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: "ashcorp-secret",
      })
    );
  console.log('got here - ', response)

    cachedSecrets = JSON.parse(response.SecretString);
    console.log("✅ AWS Secrets loaded", cachedSecrets);

    return cachedSecrets;
  } catch (err) {
    cachedSecrets = {};
    return {};
    // throw new Error("❌ Failed to load AWS Secrets:", err);
  }
  
    // cachedSecrets = {};
    // console.log("✅ AWS Secrets loaded", cachedSecrets);
    // return cachedSecrets;
}

export function getSecrets() {
  if (!cachedSecrets) {
    throw new Error("❌ Secrets not loaded yet");
  }
  return cachedSecrets;
}