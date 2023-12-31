import {
  AccountUpdate,
  Bool,
  Field,
  isReady,
  MerkleTree,
  Mina,
  PublicKey,
  PrivateKey,
  shutdown,
  UInt64,
} from 'snarkyjs';
import { MAIN_PASSWORD } from './WalletZkApp.js';
import { Biometric, Guardian, WalletZkApp } from './index.js';
import { Nullifier } from './Nullifier.js';
// import { hexToUint8Array, messageToUint8Array } from './utils/encoding.js';
// import { getPublicKey } from '@noble/secp256k1';

let proofsEnabled = false;

const biometricTree = new MerkleTree(4);
const guardianTree = new MerkleTree(8);
const facialScan = Biometric.from(Field(1));
const fingerprint = Biometric.from(Field(2));
const irisScan = Biometric.from(Field(3));
const voicePrint = Biometric.from(Field(4));

biometricTree.setLeaf(0n, facialScan.hash());
biometricTree.setLeaf(1n, fingerprint.hash());
biometricTree.setLeaf(2n, irisScan.hash());
biometricTree.setLeaf(3n, voicePrint.hash());

describe('WalletZkApp', () => {
  let deployerAccount: PublicKey,
    deployerKey: PrivateKey,
    guardian1Account: PublicKey,
    guardian1Key: PrivateKey,
    guardian2Account: PublicKey,
    guardian2Key: PrivateKey,
    guardian3Account: PublicKey,
    guardian3Key: PrivateKey,
    senderAccount: PublicKey,
    senderKey: PrivateKey,
    zkAppAddress: PublicKey,
    zkAppPrivateKey: PrivateKey,
    zkApp: WalletZkApp;

  beforeAll(async () => {
    await isReady;
    if (proofsEnabled) WalletZkApp.compile();
  });

  beforeEach(() => {
    const Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    ({ privateKey: deployerKey, publicKey: deployerAccount } =
      Local.testAccounts[0]);
    ({ privateKey: guardian1Key, publicKey: guardian1Account } =
      Local.testAccounts[1]);
    ({ privateKey: guardian2Key, publicKey: guardian2Account } =
      Local.testAccounts[2]);
    ({ privateKey: guardian3Key, publicKey: guardian3Account } =
      Local.testAccounts[3]);
    ({ privateKey: senderKey, publicKey: senderAccount } =
      Local.testAccounts[4]);
    zkAppPrivateKey = PrivateKey.random();
    zkAppAddress = zkAppPrivateKey.toPublicKey();
    zkApp = new WalletZkApp(zkAppAddress);

    guardianTree.setLeaf(
      0n,
      Guardian.from(guardian1Account, Field(1), Field(1)).hash()
    );
    guardianTree.setLeaf(
      1n,
      Guardian.from(guardian2Account, Field(2), Field(1)).hash()
    );
    guardianTree.setLeaf(
      2n,
      Guardian.from(guardian3Account, Field(3), Field(1)).hash()
    );
    guardianTree.setLeaf(
      3n,
      Guardian.from(PublicKey.empty(), Field(0), Field(0)).hash()
    );
  });

  afterAll(() => {
    // `shutdown()` internally calls `process.exit()` which will exit the running Jest process early.
    // Specifying a timeout of 0 is a workaround to defer `shutdown()` until Jest is done running all tests.
    // This should be fixed with https://github.com/MinaProtocol/mina/issues/10943
    setTimeout(shutdown, 0);
  });

  async function localDeploy() {
    const txn = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      //feePayerUpdate.send({ to: senderAccount, amount: 100 });
      zkApp.deploy();
    });
    await txn.prove();
    // this tx needs .sign(), because `deploy()` adds an account update that requires signature authorization
    await txn.sign([deployerKey, zkAppPrivateKey]).send();

    console.log('deploy and fund user accounts');
  }

  describe('#init', () => {
    it('generates and deploys the `WalletZkApp` smart contract', async () => {
      await localDeploy();

      const mainPassword = zkApp.mainPassword.get();
      expect(mainPassword).toEqual(MAIN_PASSWORD);
      const commitedBiometrics = zkApp.commitedBiometrics.get();
      expect(commitedBiometrics).toEqual(Field(0));
      const committedGuardians = zkApp.committedGuardians.get();
      expect(committedGuardians).toEqual(Field(0));
      const guardianCounter = zkApp.guardianCounter.get();
      expect(guardianCounter).toEqual(Field(0));
    });
  });

  describe('#addBiometrics', () => {
    it('correctly updates the commitedBiometrics state on the `WalletZkApp` smart contract', async () => {
      await localDeploy();

      // update transaction
      const txn = await Mina.transaction(deployerAccount, () => {
        zkApp.addBiometrics(MAIN_PASSWORD, biometricTree.getRoot(), Bool(true));
      });
      await txn.prove();
      await txn.sign([deployerKey]).send();

      const updatedCommitedBiometrics = zkApp.commitedBiometrics.get();
      expect(updatedCommitedBiometrics).toEqual(biometricTree.getRoot());
    });
  });

  describe('#addGuardians', () => {
    it('correctly updates the guardianCounter state on the `WalletZkApp` smart contract using password', async () => {
      await localDeploy();

      const txn = await Mina.transaction(deployerAccount, () => {
        zkApp.addGuadians(MAIN_PASSWORD, guardianTree.getRoot(), Field(3));
      });
      await txn.prove();
      await txn.sign([deployerKey]).send();

      const updatedGuardianCounter = zkApp.guardianCounter.get();
      expect(updatedGuardianCounter).toEqual(Field(3));
    });
  });

  describe('#deposit', () => {
    it('correctly updates the balance state on the `WalletZkApp` smart contract', async () => {
      await localDeploy();
      const amount: UInt64 = UInt64.from(1e9).div(1e9);
      const txn = await Mina.transaction(senderAccount, () => {
        zkApp.deposit(amount);
      });
      await txn.prove();
      await txn.sign([senderKey]).send();

      const updatedBalance = Mina.getBalance(zkApp.address);
      console.log('updatedBalance', updatedBalance.toString());
      expect(updatedBalance).toEqual(amount);
    });
  });

  describe('#withdraw', () => {
    const amount: UInt64 = UInt64.from(1e9).div(1e9);
    beforeEach(async () => {
      await localDeploy();
      const txn = await Mina.transaction(senderAccount, () => {
        zkApp.deposit(amount);
      });
      await txn.prove();
      await txn.sign([senderKey]).send();
    });
    it('should able to withdraw from smart contract wallet', async () => {
      const txn = await Mina.transaction(deployerAccount, () => {
        zkApp.withdraw(deployerAccount, amount);
      });
      await txn.prove();
      await txn.sign([deployerKey]).send();

      const updatedBalance = Mina.getBalance(zkApp.address);
      console.log('updatedBalance', updatedBalance.toString());
      expect(updatedBalance.toString()).toEqual('0');
    });
    it('should not able to withdraw when pause', async () => {
      await Mina.transaction(deployerAccount, () => {
        zkApp.pause();
      });
      const txn = await Mina.transaction(deployerAccount, () => {
        zkApp.withdraw(deployerAccount, amount);
      });
      await txn.prove();
      await txn.sign([deployerKey]).send();

      console.log('txn', txn);

      // const updatedBalance = Mina.getBalance(zkApp.address);
      // console.log('updatedBalance', updatedBalance.toString());
      // expect(updatedBalance.toString()).toEqual('1000000000');
    });
  });

  describe('#pause', () => {
    it('correctly updates the paused state on the `WalletZkApp` smart contract', async () => {
      await localDeploy();

      const txn = await Mina.transaction(deployerAccount, () => {
        zkApp.pause();
      });
      await txn.prove();
      await txn.sign([deployerKey]).send();

      const paused = zkApp.paused.get();
      expect(paused).toEqual(Bool(true));
    });
  });

  describe('#unpause', () => {
    it('correctly updates the paused state on the `WalletZkApp` smart contract', async () => {
      await localDeploy();

      const txn1 = await Mina.transaction(deployerAccount, () => {
        zkApp.pause();
      });
      await txn1.prove();
      await txn1.sign([deployerKey]).send();

      const txn2 = await Mina.transaction(deployerAccount, () => {
        zkApp.unpause();
      });
      await txn2.prove();
      await txn2.sign([deployerKey]).send();

      const paused = zkApp.paused.get();
      expect(paused).toEqual(Bool(false));
    });
  });

  describe('#generateNullifier', () => {
    it('correctly generates a nullifier', async () => {
      await localDeploy();

      let nullifier = Nullifier.from(
        '519b423d715f8b581f4fa8ee59f4771a5b44c8130b4e3eacca54a56dda72b464',
        'An example app message string',
        '',
        ''
      );

      const txn = await Mina.transaction(deployerAccount, () => {
        zkApp.generateNullifier(nullifier);
      });

      console.log(nullifier.nullifierX);
      console.log(nullifier.nullifierY);

      await txn.prove();
      await txn.sign([deployerKey]).send();
    });
  });
});
