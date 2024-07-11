// index.js

import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import axios from "axios";
import readline from "readline";
import { createClient } from "@sanity/client";
import { htmlToBlocks } from "@sanity/block-tools";
import { Schema } from "@sanity/schema";
import { JSDOM } from "jsdom";

// Extract specific environment variables
const { WEBFLOW_API_KEY, SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN } =
  process.env;

// Initialize Sanity client
const sanity = createClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  token: SANITY_TOKEN,
  apiVersion: "2024-07-10",
  useCdn: false, // CDN not used for writes
});

// Setting up readline for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Function to fetch all Webflow sites associated with the user's API key
async function fetchWebflowSites() {
  const url = "https://api.webflow.com/v2/sites";
  try {
    const response = await axios.get(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${WEBFLOW_API_KEY}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching Webflow sites:`, error);
    return [];
  }
}

// Function to fetch collections associated with a specific Webflow site
async function fetchCollectionsForSite(siteId) {
  const url = `https://api.webflow.com/v2/sites/${siteId}/collections`;
  try {
    const response = await axios.get(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${WEBFLOW_API_KEY}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching collections for site ID ${siteId}:`, error);
    return [];
  }
}

// Function to fetch items from a specific Webflow collection
async function fetchCollectionItems(collectionId) {
  const items = [];
  const limit = 100;
  let offset = 0;
  let moreItems = true;

  while (moreItems) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`;
    try {
      const response = await axios.get(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${WEBFLOW_API_KEY}`,
        },
      });
      items.push(...response.data.items);
      moreItems = response.data.items.length === limit; // Check if there are more items to fetch
      offset += limit; // Update offset for next fetch
    } catch (error) {
      console.error(
        `Error fetching collection items for collection ID ${collectionId}:`,
        error
      );
      moreItems = false; // Stop fetching if there's an error
    }
  }

  return items;
}

// Function to get user's selection from a list of items
async function getUserSelection(message, items) {
  console.log("START!!!");
  // Log the type and structure of items
  console.log(`Type of items: ${typeof items}`);
  console.log(`Items:`, items);

  // Check for the first array in items
  const firstArrayKey = Object.keys(items).find(
    (key) =>
      Array.isArray(items[key]) ||
      (items[key] && Array.isArray(items[key].collections))
  );
  const targetArray = Array.isArray(items[firstArrayKey])
    ? items[firstArrayKey]
    : items[firstArrayKey]?.collections;

  return new Promise((resolve) => {
    if (Array.isArray(targetArray)) {
      targetArray.forEach((item, index) => {
        console.log(`${index + 1}. ${item.displayName} (ID: ${item.id})`);
      });
      rl.question(message, (answer) => {
        const choice = parseInt(answer) - 1;
        if (choice >= 0 && choice < targetArray.length) {
          resolve(targetArray[choice]);
        } else {
          console.error("Invalid selection. Please try again.");
          resolve(getUserSelection(message, items)); // Recursive call if invalid selection
        }
      });
    } else {
      console.error("Items is not an array. Please check the data structure.");
      resolve(null); // Resolve with null if items is not an array
    }
  });
}

// Sanity schema definition for block content conversion
const blockContentType = Schema.compile({
  name: "exampleSchema",
  types: [
    {
      type: "object",
      name: "exampleSchema",
      fields: [
        {
          name: "title",
          type: "string",
        },
        {
          name: "body",
          title: "Body",
          type: "array",
          of: [{ type: "block" }],
        },
      ],
    },
  ],
})
  .get("exampleSchema")
  .fields.find((field) => field.name === "body").type;

// Function to map a Webflow item to the corresponding Sanity schema
function mapToSanitySchema(webflowItem) {
  console.log(webflowItem.fieldData);
  console.log(webflowItem.fieldData["post-body"]);
  const file_url = webflowItem["file-url"] || "";

  const { window } = new JSDOM("");
  const DOMParser = window.DOMParser;
  global.DOMParser = DOMParser; // You may want to reset this afterward if you're concerned about polluting the global namespace

  const blockContent = htmlToBlocks(
    webflowItem.fieldData["post-body"],
    blockContentType
  );

  return {
    _type: "exampleSchema",
    // keep the original ID in case we need to reference it later
    _id: `imported-${webflowItem.id}`,
    // map the title to the title field in Sanity
    title: webflowItem.fieldData["name"],
    // strip html br and p tags
    // description: webflowItem.description
    //   .replace(/<br>/g, "")
    //   .replace(/<p>/g, "")
    //   .replace(/<\/p>/g, ""),
    // map the slug to the slug field in Sanity
    slug: { current: webflowItem.fieldData.slug },
    // mapped html to block content
    body: blockContent,
    // if the image is not set, we don't want to set the field at all
    image: webflowItem?.image
      ? {
          asset: {
            url: webflowItem.image.url,
          },
          alt: webflowItem.image.alt || "",
        }
      : undefined,
    file: file_url
      ? {
          asset: {
            url: file_url,
          },
          alt: "",
        }
      : undefined,
  };
}

// Function to handle the upload of documents to Sanity
async function uploadToSanity(sanityDocuments) {
  console.log("starting to upload to sanity");
  for (const document of sanityDocuments) {
    try {
      // Handle image upload if it exists
      if (document.image?.asset.url) {
        const response = await fetch(document.image.asset.url);
        const buffer = await response.buffer();
        const asset = await sanity.assets.upload("image", buffer, {
          filename: document._id, // you can provide a more meaningful filename if you have one
        });
        document.image.asset = { _ref: asset._id };
      }
      // Handle file upload if it exists
      if (document.file?.asset.url) {
        const response = await fetch(document.file.asset.url);
        const buffer = await response.buffer();
        // Assuming the file should be uploaded as a JSON file
        const asset = await sanity.assets.upload("file", buffer, {
          filename: document._id,
          contentType: "application/json",
        });
        document.file.asset = { _ref: asset._id };
      }
      // Create or replace the document in Sanity
      await sanity.createOrReplace(document);
      console.log(`Document uploaded: ${document._id}`);
    } catch (error) {
      console.error(`Error uploading document: ${document._id}`, error);
    }
  }
}

// Main execution function
async function main() {
  // Fetch Webflow sites and get user selection
  const sites = await fetchWebflowSites();
  console.log(sites);
  const selectedSite = await getUserSelection("Choose a site: ", sites);
  console.log(selectedSite);
  // Fetch collections for selected site and get user selection
  const collections = await fetchCollectionsForSite(selectedSite.id);
  const selectedCollection = await getUserSelection(
    "Choose a collection: ",
    collections
  );

  // Fetch items from the selected collection
  console.log(selectedCollection);
  const webflowItems = await fetchCollectionItems(selectedCollection.id);

  // Map Webflow items to Sanity schema
  const sanityDocuments = webflowItems.map((item) => mapToSanitySchema(item));
  console.log(sanityDocuments);
  // Upload documents to Sanity
  uploadToSanity(sanityDocuments);

  // Close readline interface
  rl.close();
}

// Invoke the main function
main();
