/* eslint-disable no-console */
import {
  EventBridgeTestClient,
  IntegrationTestClient,
  S3TestClient,
} from '@andybalham/cdk-cloud-test-kit';
import { EventBridgeEvent } from 'aws-lambda';
import {
  TEST_FIRST_NAME,
  TEST_HIGH_CREDIT_SCORE,
  TEST_LAST_NAME_FAILED,
  TEST_LAST_NAME_LOW_CREDIT_SCORE,
  TEST_LAST_NAME_MEDIUM_CREDIT_SCORE,
  TEST_LOW_CREDIT_SCORE,
  TEST_MEDIUM_CREDIT_SCORE,
  TEST_NI_NUMBER_HAS_BANKRUPTCIES,
  TEST_POSTCODE_NOT_ON_ELECTORAL_ROLL,
} from '../../src/credit-bureau/constants';
import {
  CreditReportReceived,
  CreditReportRequested,
  EventDetailType,
  EventDomain,
  EventService,
} from '../../src/domain/domain-events';
import { CreditReport, QuoteRequest } from '../../src/domain/domain-models';
import {
  fetchFromUrlAsync,
  getDataUrlAsync,
  putDomainEventAsync,
} from '../../src/lib/utils';
import { emptyQuoteRequest } from '../lib/model-examples';
import CreditBureauTestStack from './CreditBureauTestStack';

jest.setTimeout(2 * 60 * 1000);

const defaultTestQuoteRequest: QuoteRequest = {
  ...emptyQuoteRequest,
  personalDetails: {
    ...emptyQuoteRequest.personalDetails,
    firstName: TEST_FIRST_NAME,
  },
};

const notOnElectoralRollQuoteRequest: QuoteRequest = {
  ...emptyQuoteRequest,
  personalDetails: {
    ...emptyQuoteRequest.personalDetails,
    firstName: TEST_FIRST_NAME,
    address: {
      ...emptyQuoteRequest.personalDetails.address,
      postcode: TEST_POSTCODE_NOT_ON_ELECTORAL_ROLL,
    },
  },
};

const hasBankruptciesQuoteRequest: QuoteRequest = {
  ...emptyQuoteRequest,
  personalDetails: {
    ...emptyQuoteRequest.personalDetails,
    firstName: TEST_FIRST_NAME,
    niNumber: TEST_NI_NUMBER_HAS_BANKRUPTCIES,
  },
};

const lowCreditScoreQuoteRequest: QuoteRequest = {
  ...emptyQuoteRequest,
  personalDetails: {
    ...emptyQuoteRequest.personalDetails,
    firstName: TEST_FIRST_NAME,
    lastName: TEST_LAST_NAME_LOW_CREDIT_SCORE,
  },
};

const mediumCreditScoreQuoteRequest: QuoteRequest = {
  ...emptyQuoteRequest,
  personalDetails: {
    ...emptyQuoteRequest.personalDetails,
    firstName: TEST_FIRST_NAME,
    lastName: TEST_LAST_NAME_MEDIUM_CREDIT_SCORE,
  },
};

const failedQuoteRequest: QuoteRequest = {
  ...emptyQuoteRequest,
  personalDetails: {
    ...emptyQuoteRequest.personalDetails,
    firstName: TEST_FIRST_NAME,
    lastName: TEST_LAST_NAME_FAILED,
  },
};

describe('CreditBureau tests', () => {
  //
  const testClient = new IntegrationTestClient({
    testStackId: CreditBureauTestStack.Id,
  });

  let dataBucket: S3TestClient;
  let applicationEventBus: EventBridgeTestClient;

  beforeAll(async () => {
    await testClient.initialiseClientAsync();

    dataBucket = testClient.getS3TestClient(CreditBureauTestStack.DataBucketId);

    applicationEventBus = testClient.getEventBridgeTestClient(
      CreditBureauTestStack.ApplicationEventBusId
    );
  });

  beforeEach(async () => {
    await testClient.initialiseTestAsync();
    await dataBucket.clearAllObjectsAsync();
  });

  [
    {
      quoteRequest: defaultTestQuoteRequest,
      expectedResultType: 'SUCCEEDED',
      expectedOnElectoralRoll: true,
      expectedHasBankruptcies: false,
      expectedCreditScore: TEST_HIGH_CREDIT_SCORE,
    },
    {
      quoteRequest: notOnElectoralRollQuoteRequest,
      expectedResultType: 'SUCCEEDED',
      expectedOnElectoralRoll: false,
      expectedHasBankruptcies: false,
      expectedCreditScore: TEST_HIGH_CREDIT_SCORE,
    },
    {
      quoteRequest: hasBankruptciesQuoteRequest,
      expectedResultType: 'SUCCEEDED',
      expectedOnElectoralRoll: true,
      expectedHasBankruptcies: true,
      expectedCreditScore: TEST_HIGH_CREDIT_SCORE,
    },
    {
      quoteRequest: lowCreditScoreQuoteRequest,
      expectedResultType: 'SUCCEEDED',
      expectedOnElectoralRoll: true,
      expectedHasBankruptcies: false,
      expectedCreditScore: TEST_LOW_CREDIT_SCORE,
    },
    {
      quoteRequest: mediumCreditScoreQuoteRequest,
      expectedResultType: 'SUCCEEDED',
      expectedOnElectoralRoll: true,
      expectedHasBankruptcies: false,
      expectedCreditScore: TEST_MEDIUM_CREDIT_SCORE,
    },
    {
      quoteRequest: failedQuoteRequest,
      expectedResultType: 'FAILED',
    },
  ].forEach((theory) => {
    test(`${JSON.stringify(theory)}`, async () => {
      // Arrange

      const quoteRequestDataUrl = await getDataUrlAsync({
        bucketName: dataBucket.bucketName,
        key: 'test-quote-request',
        data: JSON.stringify(theory.quoteRequest),
        expirySeconds: 5 * 60,
      });

      const creditReportRequested: CreditReportRequested = {
        metadata: {
          domain: EventDomain.LoanBroker,
          service: EventService.QuoteProcessor,
          correlationId: 'test-correlationId',
          requestId: 'test-requestId',
        },
        data: {
          quoteReference: 'test-quote-reference',
          quoteRequestDataUrl,
        },
      };

      // Act

      await putDomainEventAsync({
        eventBusName: applicationEventBus.eventBusArn,
        detailType: EventDetailType.CreditReportRequested,
        event: creditReportRequested,
      });

      // Await

      const { timedOut, observations } = await testClient.pollTestAsync({
        until: async (o) => o.length > 0,
      });

      // Assert

      expect(timedOut).toBeFalsy();

      const firstEvent = observations[0].data as EventBridgeEvent<
        'CreditReportReceived',
        CreditReportReceived
      >;

      expect(firstEvent['detail-type']).toBe(
        EventDetailType.CreditReportReceived
      );

      expect(firstEvent.detail.metadata.correlationId).toBe(
        creditReportRequested.metadata.correlationId
      );

      expect(firstEvent.detail.data.resultType).toBe(theory.expectedResultType);

      if (theory.expectedResultType === 'SUCCEEDED') {
        //
        expect(firstEvent.detail.data.creditReportDataUrl).toBeDefined();

        const actualCreditReport = await fetchFromUrlAsync<CreditReport>(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          firstEvent.detail.data.creditReportDataUrl!
        );

        expect(actualCreditReport.reportReference).toBeDefined();

        expect(actualCreditReport.hasBankruptcies).toBe(
          theory.expectedHasBankruptcies
        );

        expect(actualCreditReport.onElectoralRoll).toBe(
          theory.expectedOnElectoralRoll
        );

        expect(actualCreditReport.creditScore).toBe(theory.expectedCreditScore);
        //
      } else {
        expect(firstEvent.detail.data.resultType).toBe(theory.expectedResultType);
        expect(firstEvent.detail.data.creditReportDataUrl).toBeUndefined();
      }
    });
  });
});
