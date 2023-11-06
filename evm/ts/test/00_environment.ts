import { expect } from "chai";
import { ethers } from "ethers";
import {
  CHAIN_ID_ETH,
  CHAIN_ID_KLAYTN,
  tryNativeToHexString,
  tryNativeToUint8Array,
} from "@certusone/wormhole-sdk";
import {
  ICircleBridge__factory,
  IMessageTransmitter__factory,
  ITokenMinter__factory,
  IUSDC__factory,
  IWormhole__factory,
} from "../src/ethers-contracts";
import {
  KLAYTN_CIRCLE_BRIDGE_ADDRESS,
  KLAYTN_FORK_CHAIN_ID,
  KLAYTN_LOCALHOST,
  KLAYTN_USDC_TOKEN_ADDRESS,
  KLAYTN_WORMHOLE_ADDRESS,
  ETH_CIRCLE_BRIDGE_ADDRESS,
  ETH_FORK_CHAIN_ID,
  ETH_LOCALHOST,
  ETH_USDC_TOKEN_ADDRESS,
  ETH_WORMHOLE_ADDRESS,
  GUARDIAN_PRIVATE_KEY,
  WALLET_PRIVATE_KEY,
  WORMHOLE_GUARDIAN_SET_INDEX,
  WORMHOLE_MESSAGE_FEE,
} from "./helpers/consts";

describe("Environment Test", () => {
  describe("Global", () => {
    it("Environment Variables", () => {
      expect(WORMHOLE_MESSAGE_FEE).is.not.undefined;
      expect(WORMHOLE_GUARDIAN_SET_INDEX).is.not.undefined;
      expect(GUARDIAN_PRIVATE_KEY).is.not.undefined;
      expect(WALLET_PRIVATE_KEY).is.not.undefined;
    });
  });

  describe("Ethereum Goerli Testnet Fork", () => {
    describe("Environment", () => {
      it("Variables", () => {
        expect(ETH_LOCALHOST).is.not.undefined;
        expect(ETH_FORK_CHAIN_ID).is.not.undefined;
        expect(ETH_WORMHOLE_ADDRESS).is.not.undefined;
        expect(ETH_USDC_TOKEN_ADDRESS).is.not.undefined;
        expect(ETH_CIRCLE_BRIDGE_ADDRESS).is.not.undefined;
      });
    });

    describe("RPC", () => {
      const provider = new ethers.providers.StaticJsonRpcProvider(
        ETH_LOCALHOST
      );
      const wormhole = IWormhole__factory.connect(
        ETH_WORMHOLE_ADDRESS,
        provider
      );
      expect(wormhole.address).to.equal(ETH_WORMHOLE_ADDRESS);

      it("EVM Chain ID", async () => {
        const network = await provider.getNetwork();
        expect(network.chainId).to.equal(ETH_FORK_CHAIN_ID);
      });

      it("Wormhole", async () => {
        const chainId = await wormhole.chainId();
        expect(chainId).to.equal(CHAIN_ID_ETH as number);

        // fetch current wormhole protocol fee
        const messageFee: ethers.BigNumber = await wormhole.messageFee();
        expect(messageFee.eq(WORMHOLE_MESSAGE_FEE)).to.be.true;

        // Override guardian set
        {
          // check guardian set index
          const guardianSetIndex = await wormhole.getCurrentGuardianSetIndex();
          expect(guardianSetIndex).to.equal(WORMHOLE_GUARDIAN_SET_INDEX);

          // override guardian set
          const abiCoder = ethers.utils.defaultAbiCoder;

          // get slot for Guardian Set at the current index
          const guardianSetSlot = ethers.utils.keccak256(
            abiCoder.encode(["uint32", "uint256"], [guardianSetIndex, 2])
          );

          // Overwrite all but first guardian set to zero address. This isn't
          // necessary, but just in case we inadvertently access these slots
          // for any reason.
          const numGuardians = await provider
            .getStorageAt(wormhole.address, guardianSetSlot)
            .then((value) => ethers.BigNumber.from(value).toBigInt());
          for (let i = 1; i < numGuardians; ++i) {
            await provider.send("anvil_setStorageAt", [
              wormhole.address,
              abiCoder.encode(
                ["uint256"],
                [
                  ethers.BigNumber.from(
                    ethers.utils.keccak256(guardianSetSlot)
                  ).add(i),
                ]
              ),
              ethers.utils.hexZeroPad("0x0", 32),
            ]);
          }

          // Now overwrite the first guardian key with the devnet key specified
          // in the function argument.
          const devnetGuardian = new ethers.Wallet(GUARDIAN_PRIVATE_KEY)
            .address;
          await provider.send("anvil_setStorageAt", [
            wormhole.address,
            abiCoder.encode(
              ["uint256"],
              [
                ethers.BigNumber.from(
                  ethers.utils.keccak256(guardianSetSlot)
                ).add(
                  0 // just explicit w/ index 0
                ),
              ]
            ),
            ethers.utils.hexZeroPad(devnetGuardian, 32),
          ]);

          // change the length to 1 guardian
          await provider.send("anvil_setStorageAt", [
            wormhole.address,
            guardianSetSlot,
            ethers.utils.hexZeroPad("0x1", 32),
          ]);

          // confirm guardian set override
          const guardians = await wormhole
            .getGuardianSet(guardianSetIndex)
            .then(
              (guardianSet: any) => guardianSet[0] // first element is array of keys
            );
          expect(guardians.length).to.equal(1);
          expect(guardians[0]).to.equal(devnetGuardian);
        }
      });

      it("Wormhole SDK", async () => {
        // confirm that the Wormhole SDK is installed
        const accounts = await provider.listAccounts();
        expect(tryNativeToHexString(accounts[0], "ethereum")).to.equal(
          "00000000000000000000000090f8bf6a479f320ead074411a4b0e7944ea8c9c1"
        );
      });

      it("Circle", async () => {
        // instantiate Circle Bridge contract
        const circleBridge = ICircleBridge__factory.connect(
          ETH_CIRCLE_BRIDGE_ADDRESS,
          provider
        );

        const localMinter = await circleBridge
          .localMinter()
          .then((address) => ITokenMinter__factory.connect(address, provider));
        const tokenController = await localMinter.tokenController();

        // start prank (impersonate the Minter)
        await provider.send("anvil_impersonateAccount", [tokenController]);
        let receipt: any = await localMinter
          .connect(provider.getSigner(tokenController))
          .linkTokenPair(
            ETH_USDC_TOKEN_ADDRESS,
            KLAYTN_FORK_CHAIN_ID,
            tryNativeToUint8Array(KLAYTN_USDC_TOKEN_ADDRESS, "klaytn")
          )
          .then((tx) => tx.wait())
          .catch((msg) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [
          tokenController,
        ]);

        // fetch owner
        const bridgeOwner = await circleBridge.owner();

        // start prank (impersonate the Circle Bridge owner)
        await provider.send("anvil_impersonateAccount", [bridgeOwner]);

        receipt = await circleBridge
          .connect(provider.getSigner(bridgeOwner))
          .addRemoteTokenMessenger(
            KLAYTN_FORK_CHAIN_ID,
            tryNativeToUint8Array(KLAYTN_CIRCLE_BRIDGE_ADDRESS, "klaytn")
          )
          .then((tx) => tx.wait())
          .catch((msg) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;
        expect(await circleBridge.remoteTokenMessengers(CHAIN_ID_KLAYTN)).is.not
          .null;

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [bridgeOwner]);

        // fetch attestation manager address
        const attesterManager = await circleBridge
          .localMessageTransmitter()
          .then((address) =>
            IMessageTransmitter__factory.connect(address, provider)
          )
          .then((messageTransmitter) => messageTransmitter.attesterManager());
        const myAttester = new ethers.Wallet(GUARDIAN_PRIVATE_KEY, provider);

        // start prank (impersonate the attesterManager)
        await provider.send("anvil_impersonateAccount", [attesterManager]);

        // instantiate message transmitter
        const messageTransmitter = await circleBridge
          .localMessageTransmitter()
          .then((address) =>
            IMessageTransmitter__factory.connect(
              address,
              provider.getSigner(attesterManager)
            )
          );

        // update the number of required attestations to one
        {
          const receipt = await messageTransmitter
            .setSignatureThreshold(ethers.BigNumber.from("1"))
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;
        }

        // enable devnet guardian as attester
        {
          const receipt = await messageTransmitter
            .enableAttester(myAttester.address)
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;
        }

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [
          attesterManager,
        ]);

        // fetch number of attesters
        const numAttesters = await messageTransmitter.getNumEnabledAttesters();

        // confirm that the attester address swap was successful
        const attester = await circleBridge
          .localMessageTransmitter()
          .then((address) =>
            IMessageTransmitter__factory.connect(address, provider)
          )
          .then((messageTransmitter) =>
            messageTransmitter.getEnabledAttester(
              numAttesters.sub(ethers.BigNumber.from("1"))
            )
          );
        expect(myAttester.address).to.equal(attester);
      });

      it("USDC", async () => {
        // fetch master minter address
        const masterMinter = await IUSDC__factory.connect(
          ETH_USDC_TOKEN_ADDRESS,
          provider
        ).masterMinter();

        const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

        // start prank (impersonate the Circle masterMinter)
        await provider.send("anvil_impersonateAccount", [masterMinter]);

        // configure my wallet as minter
        {
          const usdc = IUSDC__factory.connect(
            ETH_USDC_TOKEN_ADDRESS,
            provider.getSigner(masterMinter)
          );

          const receipt = await usdc
            .configureMinter(wallet.address, ethers.constants.MaxUint256)
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;
        }

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [masterMinter]);

        // mint USDC and confirm with a balance check
        {
          const usdc = IUSDC__factory.connect(ETH_USDC_TOKEN_ADDRESS, wallet);
          const amount = ethers.utils.parseUnits("69420", 6);

          const balanceBefore = await usdc.balanceOf(wallet.address);

          const receipt = await usdc
            .mint(wallet.address, amount)
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;

          const balanceAfter = await usdc.balanceOf(wallet.address);
          expect(balanceAfter.sub(balanceBefore).eq(amount)).is.true;
        }
      });
    });
  });

  describe("Klaytn Baobab Testnet Fork", () => {
    describe("Environment", () => {
      it("Variables", () => {
        expect(KLAYTN_LOCALHOST).is.not.undefined;
        expect(KLAYTN_FORK_CHAIN_ID).is.not.undefined;
        expect(KLAYTN_WORMHOLE_ADDRESS).is.not.undefined;
        expect(KLAYTN_USDC_TOKEN_ADDRESS).is.not.undefined;
        expect(KLAYTN_CIRCLE_BRIDGE_ADDRESS).is.not.undefined;
      });
    });

    describe("RPC", () => {
      const provider = new ethers.providers.StaticJsonRpcProvider(
        KLAYTN_LOCALHOST
      );
      const wormhole = IWormhole__factory.connect(
        KLAYTN_WORMHOLE_ADDRESS,
        provider
      );
      expect(wormhole.address).to.equal(KLAYTN_WORMHOLE_ADDRESS);

      it("EVM Chain ID", async () => {
        const network = await provider.getNetwork();
        expect(network.chainId).to.equal(KLAYTN_FORK_CHAIN_ID);
      });

      it("Wormhole", async () => {
        const chainId = await wormhole.chainId();
        expect(chainId).to.equal(CHAIN_ID_KLAYTN as number);

        // fetch current wormhole protocol fee
        const messageFee = await wormhole.messageFee();
        expect(messageFee.eq(WORMHOLE_MESSAGE_FEE)).to.be.true;

        // override guardian set
        {
          // check guardian set index
          const guardianSetIndex = await wormhole.getCurrentGuardianSetIndex();
          expect(guardianSetIndex).to.equal(WORMHOLE_GUARDIAN_SET_INDEX);

          // override guardian set
          const abiCoder = ethers.utils.defaultAbiCoder;

          // get slot for Guardian Set at the current index
          const guardianSetSlot = ethers.utils.keccak256(
            abiCoder.encode(["uint32", "uint256"], [guardianSetIndex, 2])
          );

          // Overwrite all but first guardian set to zero address. This isn't
          // necessary, but just in case we inadvertently access these slots
          // for any reason.
          const numGuardians = await provider
            .getStorageAt(wormhole.address, guardianSetSlot)
            .then((value) => ethers.BigNumber.from(value).toBigInt());
          for (let i = 1; i < numGuardians; ++i) {
            await provider.send("anvil_setStorageAt", [
              wormhole.address,
              abiCoder.encode(
                ["uint256"],
                [
                  ethers.BigNumber.from(
                    ethers.utils.keccak256(guardianSetSlot)
                  ).add(i),
                ]
              ),
              ethers.utils.hexZeroPad("0x0", 32),
            ]);
          }

          // Now overwrite the first guardian key with the devnet key specified
          // in the function argument.
          const devnetGuardian = new ethers.Wallet(GUARDIAN_PRIVATE_KEY)
            .address;
          await provider.send("anvil_setStorageAt", [
            wormhole.address,
            abiCoder.encode(
              ["uint256"],
              [
                ethers.BigNumber.from(
                  ethers.utils.keccak256(guardianSetSlot)
                ).add(
                  0 // just explicit w/ index 0
                ),
              ]
            ),
            ethers.utils.hexZeroPad(devnetGuardian, 32),
          ]);

          // change the length to 1 guardian
          await provider.send("anvil_setStorageAt", [
            wormhole.address,
            guardianSetSlot,
            ethers.utils.hexZeroPad("0x1", 32),
          ]);

          // Confirm guardian set override
          const guardians = await wormhole
            .getGuardianSet(guardianSetIndex)
            .then(
              (guardianSet: any) => guardianSet[0] // first element is array of keys
            );
          expect(guardians.length).to.equal(1);
          expect(guardians[0]).to.equal(devnetGuardian);
        }
      });

      it("Wormhole SDK", async () => {
        // confirm that the Wormhole SDK is installed
        const accounts = await provider.listAccounts();
        expect(tryNativeToHexString(accounts[0], "ethereum")).to.equal(
          "00000000000000000000000090f8bf6a479f320ead074411a4b0e7944ea8c9c1"
        );
      });

      it("Circle", async () => {
        // instantiate Circle Bridge contract
        const circleBridge = ICircleBridge__factory.connect(
          KLAYTN_CIRCLE_BRIDGE_ADDRESS,
          provider
        );

        /*
        // fetch owner
        const bridgeOwner = await circleBridge.owner();

        // start prank (impersonate the Circle Bridge owner)
        await provider.send("anvil_impersonateAccount", [bridgeOwner]);

        const receipt = await circleBridge
          .connect(provider.getSigner(bridgeOwner))
          .addRemoteTokenMessenger(
            0,
            tryNativeToUint8Array(ETH_CIRCLE_BRIDGE_ADDRESS, "ethereum")
          )
          .then((tx) => tx.wait())
          .catch((msg) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [bridgeOwner]);
        */

        // fetch attestation manager address
        const attesterManager = await circleBridge
          .localMessageTransmitter()
          .then((address) =>
            IMessageTransmitter__factory.connect(address, provider)
          )
          .then((messageTransmitter) => messageTransmitter.attesterManager());
        const myAttester = new ethers.Wallet(GUARDIAN_PRIVATE_KEY, provider);

        // start prank (impersonate the attesterManager)
        await provider.send("anvil_impersonateAccount", [attesterManager]);

        // instantiate message transmitter
        const messageTransmitter = await circleBridge
          .localMessageTransmitter()
          .then((address) =>
            IMessageTransmitter__factory.connect(
              address,
              provider.getSigner(attesterManager)
            )
          );
        const existingAttester = await messageTransmitter.getEnabledAttester(0);

        // enable devnet guardian as attester
        {
          const receipt = await messageTransmitter
            .enableAttester(myAttester.address)
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;
        }

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [
          attesterManager,
        ]);

        // fetch number of attesters
        const numAttesters = await messageTransmitter.getNumEnabledAttesters();

        // confirm that the attester address swap was successful
        const attester = await circleBridge
          .localMessageTransmitter()
          .then((address) =>
            IMessageTransmitter__factory.connect(address, provider)
          )
          .then((messageTransmitter) =>
            messageTransmitter.getEnabledAttester(
              numAttesters.sub(ethers.BigNumber.from("1"))
            )
          );
        expect(myAttester.address).to.equal(attester);
      });

      it("USDC", async () => {
        // fetch master minter address
        const masterMinter = await IUSDC__factory.connect(
          KLAYTN_USDC_TOKEN_ADDRESS,
          provider
        ).masterMinter();

        const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

        // start prank (impersonate the Circle masterMinter)
        await provider.send("anvil_impersonateAccount", [masterMinter]);

        // configure my wallet as minter
        {
          const usdc = IUSDC__factory.connect(
            KLAYTN_USDC_TOKEN_ADDRESS,
            provider.getSigner(masterMinter)
          );

          const receipt = await usdc
            .configureMinter(wallet.address, ethers.constants.MaxUint256)
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;
        }

        // stop prank
        await provider.send("anvil_stopImpersonatingAccount", [masterMinter]);

        // mint USDC and confirm with a balance check
        {
          const usdc = IUSDC__factory.connect(
            KLAYTN_USDC_TOKEN_ADDRESS,
            wallet
          );
          const amount = ethers.utils.parseUnits("69420", 6);

          const balanceBefore = await usdc.balanceOf(wallet.address);

          const receipt = await usdc
            .mint(wallet.address, amount)
            .then((tx) => tx.wait())
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;

          const balanceAfter = await usdc.balanceOf(wallet.address);
          expect(balanceAfter.sub(balanceBefore).eq(amount)).is.true;
        }
      });
    });
  });
});
