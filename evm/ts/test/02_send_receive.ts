import { expect } from "chai";
import { ethers } from "ethers";
import {
  CHAIN_ID_ALGORAND,
  CHAIN_ID_KLAYTN,
  CHAIN_ID_ETH,
  tryNativeToUint8Array,
} from "@certusone/wormhole-sdk";
import {
  KLAYTN_USDC_TOKEN_ADDRESS,
  ETH_USDC_TOKEN_ADDRESS,
  GUARDIAN_PRIVATE_KEY,
  WORMHOLE_GUARDIAN_SET_INDEX,
  ETH_LOCALHOST,
  WALLET_PRIVATE_KEY,
  WALLET_PRIVATE_KEY_TWO,
  KLAYTN_LOCALHOST,
  ETH_FORK_CHAIN_ID,
  KLAYTN_FORK_CHAIN_ID,
  ETH_WORMHOLE_ADDRESS,
  KLAYTN_WORMHOLE_ADDRESS,
} from "./helpers/consts";
import {
  ICircleIntegration__factory,
  IUSDC__factory,
  IMockIntegration__factory,
  IWormhole__factory,
} from "../src/ethers-contracts";
import { MockGuardians } from "@certusone/wormhole-sdk/lib/cjs/mock";
import { RedeemParameters, TransferParameters } from "../src";
import { findCircleMessageInLogs } from "../src/logs";
import {
  MockCircleAttester,
  readCircleIntegrationProxyAddress,
  readMockIntegrationAddress,
  findWormholeMessageInLogs,
  findRedeemEventInLogs,
} from "./helpers/utils";

describe("Circle Integration Send and Receive", () => {
  // ethereum wallet, CircleIntegration contract and USDC contract
  const ethProvider = new ethers.providers.StaticJsonRpcProvider(ETH_LOCALHOST);
  const ethWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, ethProvider);
  const ethCircleIntegration = ICircleIntegration__factory.connect(
    readCircleIntegrationProxyAddress(ETH_FORK_CHAIN_ID),
    ethWallet
  );
  const ethUsdc = IUSDC__factory.connect(ETH_USDC_TOKEN_ADDRESS, ethWallet);

  // klaytn wallet, CircleIntegration contract and USDC contract
  const klaytnProvider = new ethers.providers.StaticJsonRpcProvider(
    KLAYTN_LOCALHOST
  );
  const klaytnWallet = new ethers.Wallet(WALLET_PRIVATE_KEY, klaytnProvider);
  const klaytnCircleIntegration = ICircleIntegration__factory.connect(
    readCircleIntegrationProxyAddress(KLAYTN_FORK_CHAIN_ID),
    klaytnWallet
  );
  const klaytnUsdc = IUSDC__factory.connect(
    KLAYTN_USDC_TOKEN_ADDRESS,
    klaytnWallet
  );

  // mock integration contract on klaytn
  const klaytnMockIntegration = IMockIntegration__factory.connect(
    readMockIntegrationAddress(KLAYTN_FORK_CHAIN_ID),
    klaytnWallet
  );

  // MockGuardians and MockCircleAttester objects
  const guardians = new MockGuardians(WORMHOLE_GUARDIAN_SET_INDEX, [
    GUARDIAN_PRIVATE_KEY,
  ]);
  const circleAttester = new MockCircleAttester(GUARDIAN_PRIVATE_KEY);

  // Wormhole contracts
  const ethWormhole = IWormhole__factory.connect(
    ETH_WORMHOLE_ADDRESS,
    ethWallet
  );
  const klaytnWormhole = IWormhole__factory.connect(
    KLAYTN_WORMHOLE_ADDRESS,
    klaytnWallet
  );

  describe("Transfer With Payload Logic", () => {
    const amountFromEth = ethers.BigNumber.from("69");
    const amountFromKlaytn = ethers.BigNumber.from("420");

    let localVariables: any = {};

    it("Should Transfer Tokens With Payload On Ethereum", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: ETH_USDC_TOKEN_ADDRESS,
        amount: amountFromEth,
        targetChain: CHAIN_ID_KLAYTN as number,
        mintRecipient: tryNativeToUint8Array(klaytnWallet.address, "klaytn"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("All your base are belong to us.");

      // increase allowance
      {
        const receipt = await ethUsdc
          .approve(ethCircleIntegration.address, amountFromEth)
          .then((tx) => tx.wait());
      }

      // grab USDC balance before performing the transfer
      const balanceBefore = await ethUsdc.balanceOf(ethWallet.address);

      // call transferTokensWithPayload
      const receipt = await ethCircleIntegration
        .transferTokensWithPayload(params, batchId, payload)
        .then(async (tx) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // check USDC balance after to confirm the transfer worked
      const balanceAfter = await ethUsdc.balanceOf(ethWallet.address);
      expect(balanceBefore.sub(balanceAfter).eq(amountFromEth)).is.true;

      // grab Circle message from logs
      const circleMessage = await ethCircleIntegration
        .circleTransmitter()
        .then((address) => findCircleMessageInLogs(receipt!.logs, address));
      expect(circleMessage).is.not.null;

      // grab attestation
      const circleAttestation = circleAttester.attestMessage(
        ethers.utils.arrayify(circleMessage!)
      );

      // now grab the Wormhole message
      const wormholeMessage = await ethCircleIntegration
        .wormhole()
        .then((address) =>
          findWormholeMessageInLogs(
            receipt!.logs,
            address,
            CHAIN_ID_ETH as number
          )
        );
      expect(wormholeMessage).is.not.null;

      // sign the DepositWithPayload message
      const encodedWormholeMessage = Uint8Array.from(
        guardians.addSignatures(wormholeMessage!, [0])
      );

      // save all of the redeem parameters
      localVariables.circleBridgeMessage = circleMessage!;
      localVariables.circleAttestation = circleAttestation!;
      localVariables.encodedWormholeMessage = encodedWormholeMessage;
    });

    it("Should Redeem Tokens With Payload On Klaytn", async () => {
      // create RedeemParameters struct to invoke the target contract with
      const redeemParameters: RedeemParameters = {
        circleBridgeMessage: localVariables.circleBridgeMessage!,
        circleAttestation: localVariables.circleAttestation!,
        encodedWormholeMessage: localVariables.encodedWormholeMessage!,
      };

      // clear the localVariables object
      localVariables = {};

      // grab the balance before redeeming the transfer
      const balanceBefore = await klaytnUsdc.balanceOf(klaytnWallet.address);

      // redeem the transfer
      const receipt = await klaytnCircleIntegration
        .redeemTokensWithPayload(redeemParameters)
        .then(async (tx) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // parse the wormhole message
      const parsedMessage = await klaytnWormhole.parseVM(
        redeemParameters.encodedWormholeMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findRedeemEventInLogs(
        receipt!.logs,
        klaytnCircleIntegration.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // confirm expected balance change
      const balanceAfter = await klaytnUsdc.balanceOf(klaytnWallet.address);
      expect(balanceAfter.sub(balanceBefore).eq(amountFromEth)).is.true;
    });

    it("Should Transfer Tokens With Payload On Klaytn", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: KLAYTN_USDC_TOKEN_ADDRESS,
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array(klaytnWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Send me back to Ethereum!");

      // increase allowance
      {
        const receipt = await klaytnUsdc
          .approve(klaytnCircleIntegration.address, amountFromKlaytn)
          .then((tx) => tx.wait());
      }

      // grab USDC balance before performing the transfer
      const balanceBefore = await klaytnUsdc.balanceOf(klaytnWallet.address);

      // call transferTokensWithPayload
      const receipt = await klaytnCircleIntegration
        .transferTokensWithPayload(params, batchId, payload)
        .then(async (tx) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // check USDC balance after to confirm the transfer worked
      const balanceAfter = await klaytnUsdc.balanceOf(klaytnWallet.address);
      expect(balanceBefore.sub(balanceAfter).eq(amountFromKlaytn)).is.true;

      // grab Circle message from logs
      const circleMessage = await klaytnCircleIntegration
        .circleTransmitter()
        .then((address) => findCircleMessageInLogs(receipt!.logs, address));
      expect(circleMessage).is.not.null;

      // grab attestation
      const circleAttestation = circleAttester.attestMessage(
        ethers.utils.arrayify(circleMessage!)
      );

      // now grab the Wormhole message
      const wormholeMessage = await klaytnCircleIntegration
        .wormhole()
        .then((address) =>
          findWormholeMessageInLogs(
            receipt!.logs,
            address,
            CHAIN_ID_KLAYTN as number
          )
        );
      expect(wormholeMessage).is.not.null;

      // sign the Wormhole message
      const encodedWormholeMessage = Uint8Array.from(
        guardians.addSignatures(wormholeMessage!, [0])
      );

      // save all of the redeem parameters
      localVariables.circleBridgeMessage = circleMessage!;
      localVariables.circleAttestation = circleAttestation!;
      localVariables.encodedWormholeMessage = encodedWormholeMessage;
    });

    it("Should Redeem Tokens With Payload On Ethereum", async () => {
      // create RedeemParameters struct to invoke the target contract with
      const redeemParameters: RedeemParameters = {
        circleBridgeMessage: localVariables.circleBridgeMessage!,
        circleAttestation: localVariables.circleAttestation!,
        encodedWormholeMessage: localVariables.encodedWormholeMessage!,
      };

      // NOTICE: don't clear the localVariables object, the values are used in the next test

      // grab the balance before redeeming the transfer
      const balanceBefore = await ethUsdc.balanceOf(ethWallet.address);

      // redeem the transfer
      const receipt = await ethCircleIntegration
        .redeemTokensWithPayload(redeemParameters)
        .then(async (tx) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // parse the wormhole message
      const parsedMessage = await ethWormhole.parseVM(
        redeemParameters.encodedWormholeMessage
      );

      // fetch the Redeem event emitted by the contract
      const event = findRedeemEventInLogs(
        receipt!.logs,
        ethCircleIntegration.address
      );
      expect(event.emitterChainId).to.equal(parsedMessage.emitterChainId);
      expect(event.emitterAddress).to.equal(parsedMessage.emitterAddress);
      expect(event.sequence.toString()).to.equal(
        parsedMessage.sequence.toString()
      );

      // confirm expected balance change
      const balanceAfter = await ethUsdc.balanceOf(ethWallet.address);
      expect(balanceAfter.sub(balanceBefore).eq(amountFromKlaytn)).is.true;
    });

    it("Should Not Redeem a Transfer More Than Once", async () => {
      // Reuse the RedeemParameters from the previous test to try to redeem again
      const redeemParameters: RedeemParameters = {
        circleBridgeMessage: localVariables.circleBridgeMessage!,
        circleAttestation: localVariables.circleAttestation!,
        encodedWormholeMessage: localVariables.encodedWormholeMessage!,
      };

      // clear the localVariables object
      localVariables = {};

      // grab the balance before redeeming the transfer
      const balanceBefore = await ethUsdc.balanceOf(ethWallet.address);

      // try to redeem the transfer again
      let failed: boolean = false;
      try {
        const receipt = await ethCircleIntegration
          .redeemTokensWithPayload(redeemParameters)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          });
      } catch (e: any) {
        expect(e.error.reason, "execution reverted: message already consumed")
          .to.be.equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;

      // confirm expected balance change
      const balanceAfter = await ethUsdc.balanceOf(ethWallet.address);
      expect(balanceAfter.eq(balanceBefore)).is.true;
    });

    it("Should Not Allow Transfers for Zero Amount", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: klaytnWallet.address,
        amount: ethers.BigNumber.from("0"), // zero amount
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array(ethWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Send zero tokens :)");

      // try to initiate a transfer with an amount of zero
      let failed: boolean = false;
      try {
        const receipt = await klaytnCircleIntegration
          .transferTokensWithPayload(params, batchId, payload)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          });
      } catch (e: any) {
        expect(e.error.reason, "execution reverted: amount must be > 0").to.be
          .equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;
    });

    it("Should Not Allow Transfers to the Zero Address", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: klaytnWallet.address,
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array("0x", "ethereum"), // zero address
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Sending to bytes32(0) mintRecipient :)");

      // try to initiate a transfer to the zero address
      let failed: boolean = false;
      try {
        const receipt = await klaytnCircleIntegration
          .transferTokensWithPayload(params, batchId, payload)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          });
      } catch (e: any) {
        expect(e.error.reason, "execution reverted: invalid mint recipient").to
          .be.equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;
    });

    it("Should Not Allow Transfers for Unregistered Tokens", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: klaytnWallet.address, // unregistered "token"
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array(ethWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Sending an unregistered token :)");

      // try to initiate a transfer for an unregistered token
      let failed: boolean = false;
      try {
        const receipt = await klaytnCircleIntegration
          .transferTokensWithPayload(params, batchId, payload)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          });
      } catch (e: any) {
        expect(e.error.reason, "execution reverted: token not accepted").to.be
          .equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;
    });

    it("Should Not Allow Transfers to Unregistered Contracts", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: klaytnWallet.address,
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ALGORAND as number, // unregistered chain
        mintRecipient: tryNativeToUint8Array(ethWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Sending to an unregistered chain :)");

      // try to initiate a transfer to an unregistered CircleIntegration contract
      let failed: boolean = false;
      try {
        const receipt = await klaytnCircleIntegration
          .transferTokensWithPayload(params, batchId, payload)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          });
      } catch (e: any) {
        expect(
          e.error.reason,
          "execution reverted: target contract not registered"
        ).to.be.equal;
        failed = true;
      }

      // confirm that the call failed
      expect(failed).is.true;
    });

    it("Should Only Mint Tokens to the Mint Recipient", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: KLAYTN_USDC_TOKEN_ADDRESS,
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array(ethWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Send me back to Ethereum!");

      // increase allowance
      const receipt = await klaytnUsdc
        .approve(klaytnCircleIntegration.address, amountFromKlaytn)
        .then((tx) => tx.wait());

      // call transfer with payload and save redeemParameters struct
      let redeemParameters = {} as RedeemParameters;
      {
        // grab USDC balance before performing the transfer
        const balanceBefore = await klaytnUsdc.balanceOf(klaytnWallet.address);

        // call transferTokensWithPayload
        const receipt = await klaytnCircleIntegration
          .transferTokensWithPayload(params, batchId, payload)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          })
          .catch((msg) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // check USDC balance after to confirm the transfer worked
        const balanceAfter = await klaytnUsdc.balanceOf(klaytnWallet.address);
        expect(balanceBefore.sub(balanceAfter).eq(amountFromKlaytn)).is.true;

        // grab Circle message from logs
        const circleMessage = await klaytnCircleIntegration
          .circleTransmitter()
          .then((address) => findCircleMessageInLogs(receipt!.logs, address));
        expect(circleMessage).is.not.null;

        // grab attestation
        const circleAttestation = circleAttester.attestMessage(
          ethers.utils.arrayify(circleMessage!)
        );

        // now grab the Wormhole Message
        const wormholeMessage = await klaytnCircleIntegration
          .wormhole()
          .then((address) =>
            findWormholeMessageInLogs(
              receipt!.logs,
              address,
              CHAIN_ID_KLAYTN as number
            )
          );
        expect(wormholeMessage).is.not.null;

        // sign the wormhole message with the guardian key
        const encodedWormholeMessage = Uint8Array.from(
          guardians.addSignatures(wormholeMessage!, [0])
        );

        // save redeemParameters struct
        redeemParameters = {
          circleBridgeMessage: ethers.utils.arrayify(circleMessage!),
          circleAttestation: circleAttestation!,
          encodedWormholeMessage: encodedWormholeMessage!,
        };
      }

      // try to redeem the transfer from a different wallet
      {
        // create wallet with different private key
        const invalidEthWallet = new ethers.Wallet(
          WALLET_PRIVATE_KEY_TWO,
          ethProvider
        );

        // connect to contract with new wallet for redemption
        const ethCircleIntegration = ICircleIntegration__factory.connect(
          readCircleIntegrationProxyAddress(ETH_FORK_CHAIN_ID),
          invalidEthWallet
        );

        let failed: boolean = false;
        try {
          // call redeemTokensWithPayload
          const receipt = await ethCircleIntegration
            .redeemTokensWithPayload(redeemParameters)
            .then(async (tx) => {
              const receipt = await tx.wait();
              return receipt;
            });
        } catch (e: any) {
          expect(
            e.error.reason,
            "execution reverted: caller must be mintRecipient"
          ).to.be.equal;
          failed = true;
        }

        // confirm that the call failed
        expect(failed).is.true;
      }

      // clear the localVariables object
      localVariables = {};
    });

    it("Should Not Redeem Tokens With a Bad Message Pair", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: KLAYTN_USDC_TOKEN_ADDRESS,
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array(ethWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Scrambled Messageggs!");

      // increase the token allowance by 2x, since we will do two transfers
      const receipt = await klaytnUsdc
        .approve(klaytnCircleIntegration.address, amountFromKlaytn.mul(2))
        .then((tx) => tx.wait());

      // send the same transfer twice and save the redeemParameters
      let redeemParameters = {} as RedeemParameters[];
      {
        for (let i = 0; i < 2; i++) {
          // grab USDC balance before performing the transfer
          const balanceBefore = await klaytnUsdc.balanceOf(
            klaytnWallet.address
          );

          // call transferTokensWithPayload
          const receipt = await klaytnCircleIntegration
            .transferTokensWithPayload(params, batchId, payload)
            .then(async (tx) => {
              const receipt = await tx.wait();
              return receipt;
            })
            .catch((msg) => {
              // should not happen
              console.log(msg);
              return null;
            });
          expect(receipt).is.not.null;

          // check USDC balance after to confirm the transfer worked
          const balanceAfter = await klaytnUsdc.balanceOf(klaytnWallet.address);
          expect(balanceBefore.sub(balanceAfter).eq(amountFromKlaytn)).is.true;

          // grab Circle message from logs
          const circleMessage = await klaytnCircleIntegration
            .circleTransmitter()
            .then((address) => findCircleMessageInLogs(receipt!.logs, address));
          expect(circleMessage).is.not.null;

          // grab attestation
          const circleAttestation = circleAttester.attestMessage(
            ethers.utils.arrayify(circleMessage!)
          );

          // now grab the Wormhole Message
          const wormholeMessage = await klaytnCircleIntegration
            .wormhole()
            .then((address) =>
              findWormholeMessageInLogs(
                receipt!.logs,
                address,
                CHAIN_ID_KLAYTN as number
              )
            );
          expect(wormholeMessage).is.not.null;

          // sign the wormhole message with the guardian key
          const encodedWormholeMessage = Uint8Array.from(
            guardians.addSignatures(wormholeMessage!, [0])
          );

          // save redeemParameters struct
          redeemParameters[i] = {
            circleBridgeMessage: ethers.utils.arrayify(circleMessage!),
            circleAttestation: circleAttestation!,
            encodedWormholeMessage: encodedWormholeMessage!,
          };
        }
      }

      // Create new redeemParameters with an invalid message pair, by
      // pairing the Wormhole message from the second transfer with
      // the Circle message and attestation from the first transfer.
      const invalidRedeemParameters: RedeemParameters = {
        circleBridgeMessage: redeemParameters[0].circleBridgeMessage,
        circleAttestation: redeemParameters[0].circleAttestation,
        encodedWormholeMessage: redeemParameters[1].encodedWormholeMessage,
      };

      {
        let failed: boolean = false;
        try {
          // call redeemTokensWithPayload
          const receipt = await ethCircleIntegration
            .redeemTokensWithPayload(invalidRedeemParameters)
            .then(async (tx) => {
              const receipt = await tx.wait();
              return receipt;
            });
        } catch (e: any) {
          expect(e.error.reason, "execution reverted: invalid message pair").to
            .be.equal;
          failed = true;
        }

        // confirm that the call failed
        expect(failed).is.true;
      }

      // clear the localVariables object
      localVariables = {};
    });

    it("Should Revert if Circle Receiver Call Fails", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: KLAYTN_USDC_TOKEN_ADDRESS,
        amount: amountFromKlaytn,
        targetChain: CHAIN_ID_ETH as number,
        mintRecipient: tryNativeToUint8Array(ethWallet.address, "ethereum"),
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("To the moon!");

      // increase allowance
      const receipt = await klaytnUsdc
        .approve(klaytnCircleIntegration.address, amountFromKlaytn)
        .then((tx) => tx.wait());

      // call transfer with payload and save redeemParameters struct
      let redeemParameters = {} as RedeemParameters;
      {
        // grab USDC balance before performing the transfer
        const balanceBefore = await klaytnUsdc.balanceOf(klaytnWallet.address);

        // call transferTokensWithPayload
        const receipt = await klaytnCircleIntegration
          .transferTokensWithPayload(params, batchId, payload)
          .then(async (tx) => {
            const receipt = await tx.wait();
            return receipt;
          })
          .catch((msg) => {
            // should not happen
            console.log(msg);
            return null;
          });
        expect(receipt).is.not.null;

        // check USDC balance after to confirm the transfer worked
        const balanceAfter = await klaytnUsdc.balanceOf(klaytnWallet.address);
        expect(balanceBefore.sub(balanceAfter).eq(amountFromKlaytn)).is.true;

        // grab Circle message from logs
        const circleMessage = await klaytnCircleIntegration
          .circleTransmitter()
          .then((address) => findCircleMessageInLogs(receipt!.logs, address));
        expect(circleMessage).is.not.null;

        // now grab the Wormhole Message
        const wormholeMessage = await klaytnCircleIntegration
          .wormhole()
          .then((address) =>
            findWormholeMessageInLogs(
              receipt!.logs,
              address,
              CHAIN_ID_KLAYTN as number
            )
          );
        expect(wormholeMessage).is.not.null;

        // sign the wormhole message with the guardian key
        const encodedWormholeMessage = Uint8Array.from(
          guardians.addSignatures(wormholeMessage!, [0])
        );

        // save redeemParameters struct
        redeemParameters = {
          circleBridgeMessage: ethers.utils.arrayify(circleMessage!),
          circleAttestation: ethers.utils.arrayify("0x"),
          encodedWormholeMessage: encodedWormholeMessage!,
        };
      }

      // try to redeem the transfer from a different wallet
      {
        let failed: boolean = false;
        try {
          // call redeemTokensWithPayload
          const receipt = await ethCircleIntegration
            .redeemTokensWithPayload(redeemParameters)
            .then(async (tx) => {
              const receipt = await tx.wait();
              return receipt;
            });
        } catch (e: any) {
          expect(
            e.error.reason,
            "execution reverted: CIRCLE_INTEGRATION: failed to mint tokens"
          ).to.be.equal;
          failed = true;
        }

        // confirm that the call failed
        expect(failed).is.true;
      }
    });
  });

  describe("Mock Integration Contract", () => {
    const amountFromEth = ethers.BigNumber.from("42069");

    // create new Klaytn wallet for mock integration contract interaction
    const klaytnMockWallet = new ethers.Wallet(
      WALLET_PRIVATE_KEY_TWO,
      klaytnProvider
    );

    let localVariables: any = {};

    it("Should Set Up Mock Integration Contract on Klaytn", async () => {
      // call the `setup` method on the MockIntegration contract
      const receipt = await klaytnMockIntegration
        .setup(klaytnCircleIntegration.address, ethWallet.address, CHAIN_ID_ETH)
        .then((tx) => tx.wait())
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // confirm that the contract is set up correctly by querying the getters
      const trustedChainId = await klaytnMockIntegration.trustedChainId();
      expect(trustedChainId).to.equal(CHAIN_ID_ETH);

      const trustedSender = await klaytnMockIntegration.trustedSender();
      expect(trustedSender).to.equal(ethWallet.address);

      const circleIntegration = await klaytnMockIntegration.circleIntegration();
      expect(circleIntegration).to.equal(klaytnCircleIntegration.address);
    });

    it("Should Transfer Tokens With Payload On Ethereum", async () => {
      // define transferTokensWithPayload function arguments
      const params: TransferParameters = {
        token: ETH_USDC_TOKEN_ADDRESS,
        amount: amountFromEth,
        targetChain: CHAIN_ID_KLAYTN as number,
        mintRecipient: tryNativeToUint8Array(
          klaytnMockIntegration.address,
          "klaytn"
        ), // set mint recipient as the Klaytn mock integration contract
      };
      const batchId = 0; // opt out of batching
      const payload = Buffer.from("Coming to a mock contract near you.");

      // increase allowance
      {
        const receipt = await ethUsdc
          .approve(ethCircleIntegration.address, amountFromEth)
          .then((tx) => tx.wait());
      }

      // grab USDC balance before performing the transfer
      const balanceBefore = await ethUsdc.balanceOf(ethWallet.address);

      // call transferTokensWithPayload
      const receipt = await ethCircleIntegration
        .transferTokensWithPayload(params, batchId, payload)
        .then(async (tx) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // check USDC balance after to confirm the transfer worked
      const balanceAfter = await ethUsdc.balanceOf(ethWallet.address);
      expect(balanceBefore.sub(balanceAfter).eq(amountFromEth)).is.true;

      // grab Circle message from logs
      const circleMessage = await ethCircleIntegration
        .circleTransmitter()
        .then((address) => findCircleMessageInLogs(receipt!.logs, address));
      expect(circleMessage).is.not.null;

      // grab attestation
      const circleAttestation = circleAttester.attestMessage(
        ethers.utils.arrayify(circleMessage!)
      );

      // now grab the Wormhole Message
      const wormholeMessage = await ethCircleIntegration
        .wormhole()
        .then((address) =>
          findWormholeMessageInLogs(
            receipt!.logs,
            address,
            CHAIN_ID_ETH as number
          )
        );
      expect(wormholeMessage).is.not.null;

      // sign the wormhole message with the guardian key
      const encodedWormholeMessage = Uint8Array.from(
        guardians.addSignatures(wormholeMessage!, [0])
      );

      // save redeem parameters and custom payload
      localVariables.circleBridgeMessage = circleMessage!;
      localVariables.circleAttestation = circleAttestation!;
      localVariables.encodedWormholeMessage = encodedWormholeMessage;
      localVariables.payload = ethers.utils.hexlify(payload);
    });

    it("Should Redeem Tokens Via Mock Integration Contract on Klaytn and Verify the Saved Payload", async () => {
      // create RedeemParameters struct to invoke the target contract with
      const redeemParameters: RedeemParameters = {
        circleBridgeMessage: localVariables.circleBridgeMessage!,
        circleAttestation: localVariables.circleAttestation!,
        encodedWormholeMessage: localVariables.encodedWormholeMessage!,
      };

      // grab USDC balance before redeeming the token transfer
      const balanceBefore = await klaytnUsdc.balanceOf(
        klaytnMockWallet.address
      );

      // Invoke the mock contract with the trusted sender wallet,
      // which shares address with eth wallet.
      const receipt = await klaytnMockIntegration
        .redeemTokensWithPayload(redeemParameters, klaytnMockWallet.address)
        .then(async (tx) => {
          const receipt = await tx.wait();
          return receipt;
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(receipt).is.not.null;

      // confirm the expected balance change for the mock Klaytn wallet
      const balanceAfter = await klaytnUsdc.balanceOf(klaytnMockWallet.address);
      expect(balanceAfter.sub(balanceBefore).eq(amountFromEth)).is.true;

      // query the mock contract and confirm that the payload was saved correctly
      const savedPayload = await await klaytnMockIntegration
        .redemptionSequence()
        .then(async (sequence) => {
          return await klaytnMockIntegration.getPayload(sequence);
        })
        .catch((msg) => {
          // should not happen
          console.log(msg);
          return null;
        });
      expect(savedPayload).is.equal(localVariables.payload);

      // clear the localVariables object
      localVariables = {};
    });
  });
});
