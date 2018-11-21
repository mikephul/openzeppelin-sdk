'use strict'
require('../../setup')

import sinon from 'sinon';
import _ from 'lodash';

import { deploy, sendTransaction, sendDataTransaction, awaitConfirmations, hasBytecode, state } from '../../../src/utils/Transactions';
import Contracts from '../../../src/utils/Contracts';
import { assertRevert, encodeCall, sleep } from '../../../src';
import advanceBlock from '../../../src/helpers/advanceBlock';
import { promisify } from 'util';
import { setInterval } from 'timers';
import axios from 'axios';

const DEFAULT_GAS = 6721975;

contract('Transactions', function([_account1, account2]) {

  beforeEach('load contract', function () {
    this.DummyImplementation = Contracts.getFromLocal('DummyImplementation');
  });

  const assertGasLt = (txHash, expected) => {
    const { gas } = web3.eth.getTransaction(txHash);
    gas.should.be.at.most(parseInt(expected));
  };

  const assertGas = (txHash, expected) => {
    const { gas } = web3.eth.getTransaction(txHash);
    gas.should.be.eq(parseInt(expected));
  };

  const assertGasPrice = (txHash, expected) => {
    const { gasPrice } = web3.eth.getTransaction(txHash);
    gasPrice.toNumber().should.be.eq(parseInt(expected));
  };

  const assertFrom = (txHash, expected) => {
    const { from } = web3.eth.getTransaction(txHash);
    from.should.be.eq(expected);
  }

  describe('via truffle', function () {
    it('uses default gas for new contract', async function () {
      const instance = await this.DummyImplementation.new();
      assertGas(instance.transactionHash, DEFAULT_GAS);
    });

    it('uses default gas for sending transaction', async function () {
      const instance = await this.DummyImplementation.new();
      const { tx } = await instance.initialize(42, 'foo', [1,2,3]);
      assertGas(tx, DEFAULT_GAS);
    });
  });

  describe('sendTransaction', function () {
    beforeEach('deploys contract', async function () {
      this.instance = await deploy(this.DummyImplementation);
    });

    afterEach('restore stubs', function () {
      sinon.restore();
    })

    it('correctly sends the transaction', async function () {
      await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]]);
      const actualValue = await this.instance.value();
      actualValue.toNumber().should.eq(42);
    });

    it('estimates gas', async function () {
      const { tx } = await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]]);
      assertGasLt(tx, 1000000);
    });

    describe('Uses an API to determine gas price', async function() {
      beforeEach('Stub API reply and simulate mainnet', async function() {
        state.network = "1";
        sinon.stub(axios, 'get').resolves({ average: 49 })
      });

      afterEach('Return to testnet and undo stub', async function() {
        delete state.network;
        delete state.gasPrice;
        sinon.restore();
      });

      it('uses gas price API when gas not specified', async function () {
        const { tx } = await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]]);
      
        assertGasPrice(tx, 49 * 1e8);
      });

      it('does not use gas price API when gasPrice specified', async function () {
        const { tx } = await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]], { gasPrice: 1234 });
      
        assertGasPrice(tx, 1234);
      });
    });

    describe('Does not blindly trust API', async function() {
      beforeEach('Stub API reply and simulate mainnet', async function() {
        state.network = "1";
        sinon.stub(axios, 'get').resolves({ average: 1234123412341234 })
      });

      afterEach('Return to testnet and undo stub', async function() {
        delete state.network;
        delete state.gasPrice;
        sinon.restore();
      });

      it('Produces an error when gas price API gives giant value', async function () {
        await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]]).should.be.rejectedWith(/is over 100 gwei/);
      });
    });

    it('uses specified gas', async function () {
      const { tx } = await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]], { gas: 800000});
      assertGas(tx, 800000);
    });

    it('honours other tx params', async function () {
      const { tx } = await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]], { from: account2 });
      assertGasLt(tx, 1000000);
      assertFrom(tx, account2);
    });

    it('handles failing transactions', async function () {
      await assertRevert(sendTransaction(this.instance.reverts));
    });

    it('retries estimating gas', async function () {
      sinon.stub(web3.eth, 'estimateGas')
        .onFirstCall().yields(new Error('gas required exceeds allowance or always failing transaction'), null)
        .yields(null, 800000)

      const { tx } = await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]]);
      assertGas(tx, 800000 * 1.25 + 15000);
    });

    it('retries estimating gas up to 3 times', async function () {
      const stub = sinon.stub(web3.eth, 'estimateGas')
      _.times(4, i => stub.onCall(i).yields(new Error('gas required exceeds allowance or always failing transaction'), null))
      stub.yields(null, 800000)

      await sendTransaction(this.instance.initialize, [42, 'foo', [1,2,3]]).should.be.rejectedWith(/always failing transaction/);
    });
  });

  describe('sendDataTransaction', function () {
    beforeEach('deploys contract', async function () {
      this.instance = await deploy(this.DummyImplementation);
      this.encodedCall = encodeCall('initialize', ['uint256', 'string', 'uint256[]'], [42, 'foo', [1,2,3]]);
    });

    it('correctly sends the transaction', async function () {      
      await sendDataTransaction(this.instance, { data: this.encodedCall });
      const actualValue = await this.instance.value();
      actualValue.toNumber().should.eq(42);
    });

    it('estimates gas', async function () {
      const { tx } = await sendDataTransaction(this.instance, { data: this.encodedCall });
      assertGasLt(tx, 1000000);
    });

    describe('Uses an API to determine gas price', async function() {
      beforeEach('Stub API reply and simulate mainnet', async function() {
        state.network = "1";
        sinon.stub(axios, 'get').resolves({ average: 49 })
      });

      afterEach('Return to testnet and undo stub', async function() {
        delete state.network;
        delete state.gasPrice;
        sinon.restore();
      });

      it('uses gas price API when gas not specified', async function () {
        const { tx } = await sendDataTransaction(this.instance, { data: this.encodedCall });
      
        assertGasPrice(tx, 49 * 1e8);
      });

      it('does not use gas price API when gasPrice specified', async function () {
        const { tx } = await sendDataTransaction(this.instance, { gasPrice: 1234, data: this.encodedCall });
      
        assertGasPrice(tx, 1234);
      });
    });

    describe('Does not blindly trust API', async function() {
      beforeEach('Stub API reply and simulate mainnet', async function() {
        state.network = "1";
        sinon.stub(axios, 'get').resolves({ average: 1234123412341234 })
      });

      afterEach('Return to testnet and undo stub', async function() {
        delete state.network;
        delete state.gasPrice;
        sinon.restore();
      });

      it('Produces an error when gas price API gives giant value', async function () {
        await sendDataTransaction(this.instance, { data: this.encodedCall }).should.be.rejectedWith(/is over 100 gwei/);
      });
    });

    it('uses specified gas', async function () {
      const { tx } = await sendDataTransaction(this.instance, { data: this.encodedCall, gas: 800000 });
      assertGas(tx, 800000);
    });

    it('honours other tx params', async function () {
      const { tx } = await sendDataTransaction(this.instance, { data: this.encodedCall, from: account2 });
      assertGasLt(tx, 1000000);
      assertFrom(tx, account2);
    });

    it('handles failing transactions', async function () {
      await assertRevert(sendDataTransaction(this.instance, { data: encodeCall('reverts') }));
    });
  });

  describe('deploy', function () {
    describe('without a constructor', function () {
      it('correctly deploys an instance', async function () {
        const instance = await deploy(this.DummyImplementation);
        (await instance.version()).should.eq("V1");
      });
  
      it('estimates gas', async function () {
        const instance = await deploy(this.DummyImplementation);
        assertGasLt(instance.transactionHash, 1000000);
      });

      describe('Uses an API to determine gas price', async function() {
        beforeEach('Stub API reply and simulate mainnet', async function() {
          state.network = "1";
          sinon.stub(axios, 'get').resolves({ average: 49 })
        });

        afterEach('Return to testnet and undo stub', async function() {
          delete state.network;
          delete state.gasPrice;
          sinon.restore();
        });

        it('uses gas price API when gas not specified', async function () {
          const instance = await deploy(this.DummyImplementation);
        
          assertGasPrice(instance.transactionHash, 49 * 1e8);
        });

        it('does not use gas price API when gasPrice specified', async function () {
          const instance = await deploy(this.DummyImplementation, [], { gasPrice: 1234 });
        
          assertGasPrice(instance.transactionHash, 1234);
        });
      });

      describe('Does not blindly trust API', async function() {
        beforeEach('Stub API reply and simulate mainnet', async function() {
          state.network = "1";
          sinon.stub(axios, 'get').resolves({ average: 1234123412341234 })
        });

        afterEach('Return to testnet and undo stub', async function() {
          delete state.network;
          delete state.gasPrice;
          sinon.restore();
        });

        it('Produces an error when gas price API gives giant value', async function () {
          await deploy(this.DummyImplementation).should.be.rejectedWith(/is over 100 gwei/);
        });
      });

      it('uses specified gas', async function () {
        const instance = await deploy(this.DummyImplementation, [], { gas: 800000 });
        assertGas(instance.transactionHash, 800000);
      });
  
      it('honours other tx params', async function () {
        const instance = await deploy(this.DummyImplementation, [], { from: account2 });
        assertGasLt(instance.transactionHash, 1000000);
        assertFrom(instance.transactionHash, account2);
      });
    });

    describe('with a constructor', function () {
      beforeEach('load contract', function () {
        this.WithConstructorImplementation = Contracts.getFromLocal('WithConstructorImplementation');
      });

      it('correctly deploys an instance', async function () {
        const instance = await deploy(this.WithConstructorImplementation, [42, "foo"]);
        (await instance.value()).toNumber().should.eq(42);
        (await instance.text()).should.eq("foo");
      });

      it('estimates gas', async function () {
        const instance = await deploy(this.WithConstructorImplementation, [42, "foo"]);
        assertGasLt(instance.transactionHash, 1000000);
      });

      describe('Uses an API to determine gas price', async function() {
        beforeEach('Stub API reply and simulate mainnet', async function() {
          state.network = "1";
          sinon.stub(axios, 'get').resolves({ average: 49 })
        });

        afterEach('Return to testnet and undo stub', async function() {
          delete state.network;
          delete state.gasPrice;
          sinon.restore();
        });

        it('uses gas price API when gas not specified', async function () {
          const instance = await deploy(this.WithConstructorImplementation, [42, 'foo']);
        
          assertGasPrice(instance.transactionHash, 49 * 1e8);
        });

        it('does not use gas price API when gasPrice specified', async function () {
          const instance = await deploy(this.WithConstructorImplementation, [42, 'foo'], { gasPrice: 1234 });
        
          assertGasPrice(instance.transactionHash, 1234);
        });
      });

      describe('Does not blindly trust API', async function() {
        beforeEach('Stub API reply and simulate mainnet', async function() {
          state.network = "1";
          sinon.stub(axios, 'get').resolves({ average: 1234123412341234 })
        });

        afterEach('Return to testnet and undo stub', async function() {
          delete state.network;
          delete state.gasPrice;
          sinon.restore();
        });

        it('Produces an error when gas price API gives giant value', async function () {
          await deploy(this.WithConstructorImplementation, [42, 'foo']).should.be.rejectedWith(/is over 100 gwei/);
        });
      });

      it('uses specified gas', async function () {
        const instance = await deploy(this.WithConstructorImplementation, [42, "foo"], { gas: 800000 });
        assertGas(instance.transactionHash, 800000);
      });
  
      it('honours other tx params', async function () {
        const instance = await deploy(this.WithConstructorImplementation, [42, "foo"], { from: account2 });
        assertGasLt(instance.transactionHash, 1000000);
        assertFrom(instance.transactionHash, account2);
      });

      it('handles failing constructors', async function () {
        await assertRevert(deploy(this.WithConstructorImplementation, [0, "foo"]));
      });
    });
  });

  describe('awaitConfirmations', function () {
    onNotGanache();

    beforeEach('enable mining', async function () {
      this.mineInterval = setInterval(advanceBlock, 100);
    })

    afterEach('disable mining', async function () {
      if (this.mineInterval) clearInterval(this.mineInterval);
      await sleep(100);
    })

    it('awaits required confirmations', async function () {
      const initialBlock = await getCurrentBlock();
      const instance = await deploy(this.DummyImplementation, [], { gasPrice: 1e9 });
      await awaitConfirmations(instance.transactionHash, 5);
      (await hasBytecode(instance.address)).should.be.true;
      const endBlock = await getCurrentBlock();
      (endBlock - 5).should.be.greaterThan(initialBlock);
    });

    it('times out if fails to reach confirmations', async function () {
      const instance = await deploy(this.DummyImplementation, [], { gasPrice: 1e9 });
      await awaitConfirmations(instance.transactionHash, 20, 100, 300).should.be.rejectedWith(/Exceeded timeout/);
    });
  });
})

async function getCurrentBlock() {
  return (promisify(web3.eth.getBlock.bind(web3.eth))('latest').then(b => b.number));
}

function onNotGanache() {
  beforeEach('stub node information', function () {
    state.nodeInfo = 'NotGanache';
  })

  afterEach('restore node info', function () {
    delete state.nodeInfo;
  })
}
