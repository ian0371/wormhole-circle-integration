import { expect } from "chai";
import { ethers } from "ethers";
import { tryNativeToUint8Array } from "@certusone/wormhole-sdk";
import {
  GUARDIAN_PRIVATE_KEY,
  WORMHOLE_GUARDIAN_SET_INDEX,
  ETH_LOCALHOST,
  WALLET_PRIVATE_KEY,
  KLAYTN_LOCALHOST,
  ETH_FORK_CHAIN_ID,
  KLAYTN_FORK_CHAIN_ID,
} from "./helpers/consts";
import { ICircleIntegration__factory } from "../src/ethers-contracts";
import { MockGuardians } from "@certusone/wormhole-sdk/lib/cjs/mock";

import { CircleGovernanceEmitter } from "./helpers/mock";
import { getTimeNow, readCircleIntegrationProxyAddress } from "./helpers/utils";

const { execSync } = require("child_process");

describe("Circle Integration Implementation Upgrade", () => {
  // ethereum wallet, CircleIntegration contract and USDC contract
  const ethProvider = new ethers.providers.StaticJsonRpcProvider(ETH_LOCALHOST);
  const ethWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, ethProvider);
  const ethProxyAddress = readCircleIntegrationProxyAddress(ETH_FORK_CHAIN_ID);
  const ethCircleIntegration = ICircleIntegration__factory.connect(
    ethProxyAddress,
    ethWallet
  );

  // Klaytn wallet, CircleIntegration contract and USDC contract
  const klaytnProvider = new ethers.providers.StaticJsonRpcProvider(
    KLAYTN_LOCALHOST
  );
  const klaytnWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, klaytnProvider);
  const klaytnProxyAddress =
    readCircleIntegrationProxyAddress(KLAYTN_FORK_CHAIN_ID);
  const klaytnCircleIntegration = ICircleIntegration__factory.connect(
    klaytnProxyAddress,
    klaytnWallet
  );

  // MockGuardians and MockCircleAttester objects
  const guardians = new MockGuardians(WORMHOLE_GUARDIAN_SET_INDEX, [
    GUARDIAN_PRIVATE_KEY,
  ]);

  const newImplementations = new Map<string, string>();

  describe("Run `yarn deploy-implementation-only`", () => {
    describe("Ethereum Goerli Testnet", () => {
      it("Deploy", async () => {
        const output = execSync(
          `RPC=${ETH_LOCALHOST} PRIVATE_KEY=${WALLET_PRIVATE_KEY} yarn deploy-implementation-only`
        ).toString();
        const address = output.match(
          /CircleIntegrationImplementation: (0x[A-Fa-f0-9]+)/
        )[1];
        newImplementations.set("ethereum", address);
      });
    });

    describe("Klaytn Baobab Testnet", () => {
      it("Deploy", async () => {
        const output = execSync(
          `RPC=${KLAYTN_LOCALHOST} PRIVATE_KEY=${WALLET_PRIVATE_KEY} yarn deploy-implementation-only`
        ).toString();
        const address = output.match(
          /CircleIntegrationImplementation: (0x[A-Fa-f0-9]+)/
        )[1];
        newImplementations.set("klaytn", address);
      });
    });
  });

  describe("Run `yarn upgrade-proxy`", () => {
    // produces governance VAAs for CircleAttestation contract
    const governance = new CircleGovernanceEmitter();

    describe("Ethereum Goerli Testnet", () => {
      const chainName = "ethereum";

      it("Upgrade", async () => {
        const timestamp = getTimeNow();
        const chainId = await ethCircleIntegration.chainId();
        const newImplementation = newImplementations.get(chainName);
        expect(newImplementation).is.not.undefined;

        {
          const initialized = await ethCircleIntegration.isInitialized(
            newImplementation!
          );
          expect(initialized).is.false;
        }

        // create unsigned upgradeContract governance message
        const published = governance.publishCircleIntegrationUpgradeContract(
          timestamp,
          chainId,
          tryNativeToUint8Array(newImplementation!, chainName)
        );

        // sign governance message with guardian key
        const signedMessage = guardians.addSignatures(published, [0]);

        // upgrade contract with new implementation
        execSync(
          `yarn upgrade-proxy \
            --rpc-url ${ETH_LOCALHOST} \
            --private-key ${WALLET_PRIVATE_KEY} \
            --proxy ${ethProxyAddress} \
            --governance-message ${signedMessage.toString("hex")}`
        );

        {
          const initialized = await ethCircleIntegration.isInitialized(
            newImplementation!
          );
          expect(initialized).is.true;
        }
      });
    });

    describe("Klaytn Baobab Testnet", () => {
      const chainName = "klaytn";

      it("Upgrade", async () => {
        const timestamp = getTimeNow();
        const chainId = await klaytnCircleIntegration.chainId();
        const newImplementation = newImplementations.get(chainName);
        expect(newImplementation).is.not.undefined;

        {
          const initialized = await klaytnCircleIntegration.isInitialized(
            newImplementation!
          );
          expect(initialized).is.false;
        }

        // create unsigned upgradeContract governance message
        const published = governance.publishCircleIntegrationUpgradeContract(
          timestamp,
          chainId,
          tryNativeToUint8Array(newImplementation!, chainName)
        );

        // sign governance message with guardian key
        const signedMessage = guardians.addSignatures(published, [0]);

        // upgrade contract with new implementation
        execSync(
          `yarn upgrade-proxy \
            --rpc-url ${KLAYTN_LOCALHOST} \
            --private-key ${WALLET_PRIVATE_KEY} \
            --proxy ${klaytnProxyAddress} \
            --governance-message ${signedMessage.toString("hex")}`
        );

        {
          const initialized = await klaytnCircleIntegration.isInitialized(
            newImplementation!
          );
          expect(initialized).is.true;
        }
      });
    });
  });
});
